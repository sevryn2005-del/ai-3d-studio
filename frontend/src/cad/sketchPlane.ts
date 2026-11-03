/**
 * 스케치 평면 좌표계 (프론트엔드 공용: 브라우저 엔진·미리보기·윤곽·그리기·크기 계산).
 * 백엔드 app/cad/frames.py 가 같은 표·같은 규칙으로 계산한다 (공유 픽스처로 교차 검증).
 *
 * 스케치 좌표 (u, v) 는 평면 위, w 는 평면 법선(돌출 방향).
 * - 기준 평면 (CadQuery 이름 평면 규약, 원점 = 법선 × offset):
 *     XY: u=X, v=Y, 법선 +Z · XZ: u=X, v=Z, 법선 −Y · YZ: u=Y, v=Z, 법선 +X
 *   돌출 객체의 로컬 좌표계에 놓인다 (돌출 객체의 transform 이 함께 움직인다).
 * - 면 평면 {type:'face', object, face, offset}: 그 객체의 "이름 있는 면" 좌표계 (docs/design-face-sketch.md).
 *   면 번호가 아니라 피처 정의(파라미터·스케치 치수)와 월드 변환만으로 계산 → 필렛·구멍·치수 변경에도 같은 면.
 *   월드에 고정되며, 돌출 객체의 로컬 좌표로는 inverse(돌출 객체 월드) ∘ (면 월드) 로 옮긴다.
 */
import { Matrix4, Vector3 } from 'three';
import type { CadObject, FaceName, ModelDefinition, ObjectId, Sketch, SketchPlane, StandardPlane } from './commandTypes';
import type { Profile } from './sketch';
import { findSketch, resolveProfile, sketchFeatureRef } from './sketch';
import { toMatrix } from './transformMath';

const BASES: Record<StandardPlane['type'], [Vector3, Vector3, Vector3]> = {
  XY: [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
  XZ: [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0)],
  YZ: [new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)],
};

export const PLANE_LABEL: Record<StandardPlane['type'], string> = {
  XY: 'XY (바닥, 위로 돌출)',
  XZ: 'XZ (정면, 앞으로 돌출)',
  YZ: 'YZ (측면, 오른쪽으로 돌출)',
};

export const FACE_LABEL: Record<FaceName, string> = {
  top: '윗면',
  bottom: '아랫면',
  '+X': '오른쪽 면 (+X)',
  '-X': '왼쪽 면 (−X)',
  '+Y': '뒷면 (+Y)',
  '-Y': '앞면 (−Y)',
  start: '시작 면 (스케치 쪽)',
  end: '끝 면',
  '+u': '옆면 +u',
  '-u': '옆면 −u',
  '+v': '옆면 +v',
  '-v': '옆면 −v',
};

/** 면 참조 재귀 한도 (순환 참조는 validateGraph 가 따로 거부한다) */
const MAX_DEPTH = 16;

/** 기준 평면 → 돌출 객체 로컬 */
export function planeMatrix(plane: StandardPlane): Matrix4 {
  const [u, v, n] = BASES[plane.type];
  return new Matrix4().makeBasis(u, v, n).setPosition(n.clone().multiplyScalar(plane.offset));
}

/** 원점·바깥 법선·u 축 → 면 좌표계 행렬 (v = 법선 × u, 오른손 좌표계) */
function frame(origin: [number, number, number], n: [number, number, number], u: [number, number, number]): Matrix4 {
  const N = new Vector3(...n);
  const U = new Vector3(...u);
  const V = new Vector3().crossVectors(N, U);
  return new Matrix4().makeBasis(U, V, N).setPosition(...origin);
}

function index(model: ModelDefinition): Map<ObjectId, CadObject> {
  return new Map(model.objects.map((o) => [o.id, o]));
}

/** 객체 로컬 → 월드 (불리언 자식은 부모 변환을 합성: world = parent ∘ child) */
export function objectWorldMatrix(model: ModelDefinition, id: ObjectId): Matrix4 {
  const byId = index(model);
  const parent = new Map<ObjectId, ObjectId>();
  for (const o of model.objects) if (o.kind === 'boolean') for (const c of [o.boolean.base, ...o.boolean.tools]) parent.set(c, o.id);
  let m = new Matrix4();
  for (let cur: ObjectId | undefined = id; cur; cur = parent.get(cur)) {
    const o = byId.get(cur);
    if (!o) break;
    m = toMatrix(o.transform).multiply(m);
  }
  return m;
}

/** 객체 종류별로 고를 수 있는 면 이름 */
export function facesOf(model: ModelDefinition, obj: CadObject, depth = 0): FaceName[] {
  if (depth > MAX_DEPTH) return [];
  switch (obj.kind) {
    case 'box':
      return ['top', 'bottom', '+X', '-X', '+Y', '-Y'];
    case 'cylinder':
    case 'cone':
      return ['top', 'bottom'];
    case 'sphere':
    case 'revolve': // 회전 결과의 이름 있는 면은 아직 없음
      return [];
    case 'extrude': {
      const sk = findSketch(model, obj.extrude.sketch);
      const p = sk ? resolveProfile(sk, obj.extrude.profile) : null;
      return p?.type === 'rectangle' ? ['end', 'start', '+u', '-u', '+v', '-v'] : ['end', 'start'];
    }
    case 'boolean': {
      const base = model.objects.find((o) => o.id === obj.boolean.base);
      return base ? facesOf(model, base, depth + 1) : [];
    }
    case 'pattern': {
      // 패턴 결과의 면 = 원본의 면 (첫 번째 사본)
      const src = model.objects.find((o) => o.id === obj.pattern.source);
      return src ? facesOf(model, src, depth + 1) : [];
    }
    case 'hole':
      return [];
  }
}

/** 객체 로컬 좌표계에서 본 면 좌표계 (원점 = 면 중심, z = 바깥 법선, x = u). 없는 면이면 null */
export function faceLocalMatrix(model: ModelDefinition, obj: CadObject, face: FaceName, depth = 0): Matrix4 | null {
  if (depth > MAX_DEPTH || !facesOf(model, obj, depth).includes(face)) return null;
  switch (obj.kind) {
    case 'box': {
      const { width: w, depth: d, height: h } = obj.params;
      const table: Partial<Record<FaceName, Matrix4>> = {
        top: frame([0, 0, h], [0, 0, 1], [1, 0, 0]),
        bottom: frame([0, 0, 0], [0, 0, -1], [1, 0, 0]),
        '+X': frame([w / 2, 0, h / 2], [1, 0, 0], [0, 1, 0]),
        '-X': frame([-w / 2, 0, h / 2], [-1, 0, 0], [0, -1, 0]),
        '+Y': frame([0, d / 2, h / 2], [0, 1, 0], [-1, 0, 0]),
        '-Y': frame([0, -d / 2, h / 2], [0, -1, 0], [1, 0, 0]),
      };
      return table[face] ?? null;
    }
    case 'cylinder':
    case 'cone': {
      const h = obj.params.height;
      return face === 'top' ? frame([0, 0, h], [0, 0, 1], [1, 0, 0]) : frame([0, 0, 0], [0, 0, -1], [1, 0, 0]);
    }
    case 'sphere':
    case 'revolve':
      return null;
    case 'extrude': {
      const sk = findSketch(model, obj.extrude.sketch);
      const p = sk ? resolveProfile(sk, obj.extrude.profile) : null;
      const local = extrudeLocalMatrix(model, obj, depth + 1);
      if (!p || !local) return null;
      const d = obj.params.distance;
      const s = Math.sign(d);
      const [cx, cy] = p.center;
      const hw = p.type === 'rectangle' ? p.width / 2 : 0;
      const hh = p.type === 'rectangle' ? p.height / 2 : 0;
      // 스케치 평면 좌표 (u, v, w). 옆면의 u 축은 v 축이 돌출 방향(+w)을 향하도록 고른다
      const inPlane: Record<string, Matrix4> = {
        end: frame([cx, cy, d], [0, 0, s], [1, 0, 0]),
        start: frame([cx, cy, 0], [0, 0, -s], [1, 0, 0]),
        '+u': frame([cx + hw, cy, d / 2], [1, 0, 0], [0, 1, 0]),
        '-u': frame([cx - hw, cy, d / 2], [-1, 0, 0], [0, -1, 0]),
        '+v': frame([cx, cy + hh, d / 2], [0, 1, 0], [-1, 0, 0]),
        '-v': frame([cx, cy - hh, d / 2], [0, -1, 0], [1, 0, 0]),
      };
      return local.multiply(inPlane[face]!);
    }
    case 'boolean': {
      // 불리언 결과의 면 = 기준(base) 객체의 면 (base 의 transform 은 불리언 기준)
      const base = model.objects.find((o) => o.id === obj.boolean.base);
      const f = base ? faceLocalMatrix(model, base, face, depth + 1) : null;
      return base && f ? toMatrix(base.transform).multiply(f) : null;
    }
    case 'pattern': {
      const src = model.objects.find((o) => o.id === obj.pattern.source);
      const f = src ? faceLocalMatrix(model, src, face, depth + 1) : null;
      return src && f ? toMatrix(src.transform).multiply(f) : null;
    }
    case 'hole':
      return null;
  }
}

/** 면 평면의 월드 좌표계 (면 좌표계에서 법선으로 offset 만큼) */
function faceWorldMatrix(model: ModelDefinition, plane: Extract<SketchPlane, { type: 'face' }>, depth: number): Matrix4 | null {
  const anchor = model.objects.find((o) => o.id === plane.object);
  const f = anchor ? faceLocalMatrix(model, anchor, plane.face, depth + 1) : null;
  if (!anchor || !f) return null;
  return objectWorldMatrix(model, anchor.id).multiply(f).multiply(new Matrix4().makeTranslation(0, 0, plane.offset));
}

/** 돌출 객체: 스케치 평면 좌표 → 돌출 객체 로컬. 참조가 깨졌거나 순환이면 null */
export function extrudeLocalMatrix(model: ModelDefinition, obj: Extract<CadObject, { kind: 'extrude' | 'revolve' }>, depth = 0): Matrix4 | null {
  if (depth > MAX_DEPTH) return null;
  const sk = findSketch(model, (obj.kind === 'extrude' ? obj.extrude : obj.revolve).sketch);
  if (!sk) return null;
  if (sk.plane.type !== 'face') return planeMatrix(sk.plane);
  const world = faceWorldMatrix(model, sk.plane, depth);
  return world ? objectWorldMatrix(model, obj.id).invert().multiply(world) : null;
}

/**
 * 스케치 좌표 → 월드 (윤곽 표시·그리기 평면).
 * 기준 평면 스케치는 그것을 쓰는 돌출 객체(preferred 우선)의 월드 변환 위에 놓는다 (없으면 원점).
 */
export function sketchWorldMatrix(model: ModelDefinition, sketch: Sketch, preferred?: ObjectId): Matrix4 | null {
  if (sketch.plane.type === 'face') return faceWorldMatrix(model, sketch.plane, 0);
  const users = model.objects.filter((o) => sketchFeatureRef(o)?.sketch === sketch.id);
  const user = users.find((o) => o.id === preferred) ?? users[0];
  const base = user ? objectWorldMatrix(model, user.id) : new Matrix4();
  return base.multiply(planeMatrix(sketch.plane));
}

/** 평면 축 이름 (속성 패널 라벨). 면 평면은 u·v */
export function planeAxes(plane: SketchPlane): [string, string] {
  switch (plane.type) {
    case 'XY':
      return ['X', 'Y'];
    case 'XZ':
      return ['X', 'Z'];
    case 'YZ':
      return ['Y', 'Z'];
    case 'face':
      return ['u', 'v'];
  }
}

/**
 * 화면 미리보기용: 중심이 원점인 Three.js 기본 도형(상자 w×h×|d|, 원통은 Y축)을 돌출 형상 위치에 놓는 행렬.
 * local = extrudeLocalMatrix. 음수 거리는 법선 반대쪽에 놓인다.
 */
export function extrudePreviewMatrix(profile: Profile, distance: number, local: Matrix4): Matrix4 {
  const m = new Matrix4().makeTranslation(profile.center[0], profile.center[1], distance / 2);
  if (profile.type === 'circle') m.multiply(new Matrix4().makeRotationX(Math.PI / 2)); // 원통 Y축 → 법선
  return local.clone().multiply(m);
}

/** 돌출 객체의 로컬 X·Y·Z 크기 (평면 크기를 로컬 축으로 회전, 위치 무관) */
export function extrudeLocalSize(local: Matrix4, [su, sv, sn]: [number, number, number]): [number, number, number] {
  const e = local.elements; // 열 우선: 열 0 = u 축, 열 1 = v 축, 열 2 = 법선
  const axis = (row: number) => Math.abs(e[row]!) * su + Math.abs(e[4 + row]!) * sv + Math.abs(e[8 + row]!) * sn;
  const r = (v: number) => Math.round(v * 1e6) / 1e6;
  return [r(axis(0)), r(axis(1)), r(axis(2))];
}

/** 면 참조 순환 검사용: 스케치가 (면 평면으로) 의존하는 객체 */
export function sketchAnchor(sketch: Sketch): ObjectId | null {
  return sketch.plane.type === 'face' ? sketch.plane.object : null;
}

/**
 * 회전 결과 좌표 → 스케치 평면 좌표. manifold 의 revolve 는 2D 단면을 Y 축 둘레로 돌리고 Y 를 Z 로 놓는다:
 * (x, y) → (x·cosθ, x·sinθ, y). 이를 u = X, v = Z, w = −Y 로 옮기면 +u 점이 −w 쪽으로 돈다 (CadQuery revolve 와 같음).
 */
export const MANIFOLD_REVOLVE_TO_PLANE = new Matrix4().makeBasis(new Vector3(1, 0, 0), new Vector3(0, 0, -1), new Vector3(0, 1, 0));

/**
 * Three.js LatheGeometry 좌표 → 스케치 평면 좌표 (미리보기). Lathe 는 (x, y) 를 Y 축 둘레로 돌려 (x·sinφ, y, x·cosφ) 를 만든다
 * → u = Z, v = Y, w = −X 로 옮기면 φ 가 커질 때 −w 쪽으로 돈다 (엔진과 같은 방향).
 */
export const LATHE_TO_PLANE = new Matrix4().makeBasis(new Vector3(0, 0, -1), new Vector3(0, 1, 0), new Vector3(1, 0, 0));
