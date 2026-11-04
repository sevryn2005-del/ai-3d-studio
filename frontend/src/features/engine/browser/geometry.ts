/**
 * 브라우저 CAD 엔진의 형상 계산 (manifold-3d). Node(테스트)와 Web Worker 양쪽에서 실행되는 순수 로직.
 *
 * 서버(backend/app/cad/primitives.py)와 같은 규칙:
 * - mm, Z-up, 원점 = 바운딩 박스 바닥면 중심, 원통·원뿔 축 = 로컬 Z
 * - 변환 행렬은 프론트엔드 transformMath.toMatrix (Three.js 와 동일) → 화면과 회전 규칙이 자동으로 일치
 * - 불리언: base 에 tools 를 순서대로 적용, 자식은 부모 기준 변환
 *
 * 차이: 서버는 정확한 곡면(B-rep), 브라우저는 다각형 근사 메시. 분할 수는 허용 오차(현의 오차)로 정한다.
 * 주의: manifold 객체는 WASM 메모리에 있으므로 반드시 delete() 해야 한다 (Scope 가 모아서 해제).
 */
import type { CadObject, ModelDefinition, ObjectId, Sketch } from '../../../cad/commandTypes';
import { byId, sketchIndex, topLevelObjects, validateGraph } from '../../../cad/modelGraph';
import { profileBounds, resolveProfile, revolveProfileError, type Profile } from '../../../cad/sketch';
import { MANIFOLD_REVOLVE_TO_PLANE, extrudeLocalMatrix } from '../../../cad/sketchPlane';
import { toMatrix } from '../../../cad/transformMath';
import { isSuppressed, patternMatrices } from '../../../cad/features';
import type { ManifoldToplevel, Manifold } from 'manifold-3d';

export const DISPLAY_TOLERANCE = 0.05; // mm (서버 DISPLAY_LINEAR_TOLERANCE 와 같음)
export const EXPORT_TOLERANCE = 0.01; // mm (서버 EXPORT_LINEAR_TOLERANCE 와 같음)
const MIN_SEGMENTS = 16;
const MAX_SEGMENTS = 512;

const OPERATION_LABEL = { cut: '빼기', union: '합치기', intersect: '교차' } as const;

export class GeometryError extends Error {}

/** 현의 오차 r(1 − cos(π/n)) ≤ tolerance 를 만족하는 분할 수 (4의 배수: 축 방향 극값에 정점이 오도록) */
export function circularSegments(radius: number, tolerance: number): number {
  if (radius <= tolerance) return MIN_SEGMENTS;
  const n = Math.ceil(Math.PI / Math.acos(1 - tolerance / radius));
  return Math.min(MAX_SEGMENTS, Math.max(MIN_SEGMENTS, Math.ceil(n / 4) * 4));
}

/**
 * 구 분할 수. 구의 삼각형 중심은 모서리 중점보다 표면에서 더 멀어서, 원 공식만으로는 편차가 허용 오차의
 * 약 2.6배가 된다 (실측: r=10, n=72 → 0.0256mm). 편차 ∝ 1/n² 이므로 1.6배로 늘려 허용 오차 이내로 맞춘다.
 */
export function sphereSegments(radius: number, tolerance: number): number {
  return Math.min(MAX_SEGMENTS, Math.ceil((circularSegments(radius, tolerance) * 1.6) / 4) * 4);
}

/** 생성한 manifold 객체(Manifold·CrossSection)를 모아 한 번에 해제한다. */
export class Scope {
  private items: { delete(): void }[] = [];
  keep<T extends { delete(): void }>(m: T): T {
    this.items.push(m);
    return m;
  }
  dispose() {
    for (const m of this.items) m.delete();
    this.items = [];
  }
}

export function localManifold(
  wasm: ManifoldToplevel,
  obj: CadObject,
  index: Map<ObjectId, CadObject>,
  tol: number,
  scope: Scope,
  sketches: Map<ObjectId, Sketch> = new Map(),
): Manifold {
  const { Manifold, CrossSection } = wasm;
  switch (obj.kind) {
    case 'extrude':
    case 'revolve': {
      // 서버 CadQuery: 평면 좌표에서 rect·circle·polyline 단면을 만들어 돌출(또는 v 축 둘레 회전)한 뒤 같은 행렬로 옮긴 형상
      const ref = obj.kind === 'extrude' ? obj.extrude : obj.revolve;
      const sk = sketches.get(ref.sketch);
      const p = sk ? resolveProfile(sk, ref.profile) : null;
      if (!p) throw new GeometryError(`'${obj.name}': 참조한 스케치 프로파일을 찾을 수 없습니다`);
      // 다각형은 꼭짓점 좌표 그대로 (구속 해석기가 푼 값). 감김 방향과 무관하게 채우도록 NonZero
      const placed =
        p.type === 'polygon'
          ? scope.keep(new CrossSection([p.points], 'NonZero'))
          : p.type === 'slot'
            ? slotSection(wasm, p, tol, scope)
            : scope.keep(
              scope
                .keep(
                  p.type === 'rectangle'
                    ? CrossSection.square([p.width, p.height], true)
                    : CrossSection.circle(p.diameter / 2, circularSegments(p.diameter / 2, tol)),
                )
                .translate(p.center),
            );
      // 평면 좌표(u, v, 법선) → 객체 로컬. 기준 평면·면 평면 모두 sketchPlane.ts 규칙 (서버 frames.py 와 같음)
      const local = extrudeLocalMatrix({ schemaVersion: 7, units: 'mm', objects: [...index.values()], sketches: [...sketches.values()] }, obj);
      if (!local) throw new GeometryError(`'${obj.name}': 스케치를 붙인 면을 찾을 수 없습니다`);
      let inPlane: Manifold;
      if (obj.kind === 'revolve') {
        const err = revolveProfileError(p);
        if (err) throw new GeometryError(`'${obj.name}': ${err}`);
        const b = profileBounds(p);
        const rMax = b.center[0] + b.width / 2;
        const segs = Math.max(8, Math.ceil((circularSegments(rMax, tol) * obj.params.angle) / 360));
        const turned = scope.keep(placed.revolve(segs, obj.params.angle));
        inPlane = scope.keep(turned.transform(MANIFOLD_REVOLVE_TO_PLANE.elements as unknown as Parameters<Manifold['transform']>[0]));
      } else {
        const d = obj.params.distance;
        let solid = scope.keep(placed.extrude(Math.abs(d)));
        if (obj.shell) {
          // 쉘: 단면을 안쪽으로 두께만큼 줄인(모서리는 연장해 만나게 = OCCT intersection) 기둥을 뺀다
          const t = obj.shell.thickness;
          const inner = scope.keep(placed.offset(-t, 'Miter', 1000));
          if (inner.isEmpty()) throw new GeometryError(`'${obj.name}': 쉘 두께가 단면보다 큽니다`);
          // 양수 거리: start = 아래(z 0), end = 위. 음수 거리는 뒤집혀 end 가 아래
          const lowOpen = obj.shell.open.includes(d > 0 ? 'start' : 'end');
          const highOpen = obj.shell.open.includes(d > 0 ? 'end' : 'start');
          const z0 = lowOpen ? -1 : t;
          const z1 = highOpen ? Math.abs(d) + 1 : Math.abs(d) - t;
          const core = scope.keep(scope.keep(inner.extrude(z1 - z0)).translate([0, 0, z0]));
          solid = scope.keep(solid.subtract(core));
        }
        inPlane = d < 0 ? scope.keep(solid.translate([0, 0, d])) : solid; // 음수 = 법선 반대쪽
      }
      return scope.keep(inPlane.transform(local.elements as unknown as Parameters<Manifold['transform']>[0]));
    }
    case 'box': {
      const { width: w, depth: d, height: h } = obj.params;
      const f = obj.edgeFeature;
      const block = (bw: number, bd: number, bh: number, z0 = 0) =>
        scope.keep(scope.keep(Manifold.cube([bw, bd, bh], false)).translate([-bw / 2, -bd / 2, z0]));
      if (obj.shell) {
        // 쉘: 안쪽 상자(열린 면 쪽은 바깥까지 연장)를 뺀다
        const t = obj.shell.thickness;
        const o = obj.shell.open;
        const lo = [o.includes('-X') ? -w / 2 - 1 : -w / 2 + t, o.includes('-Y') ? -d / 2 - 1 : -d / 2 + t, o.includes('bottom') ? -1 : t];
        const hi = [o.includes('+X') ? w / 2 + 1 : w / 2 - t, o.includes('+Y') ? d / 2 + 1 : d / 2 - t, o.includes('top') ? h + 1 : h - t];
        const core = scope.keep(scope.keep(Manifold.cube([hi[0]! - lo[0]!, hi[1]! - lo[1]!, hi[2]! - lo[2]!], false)).translate(lo as [number, number, number]));
        return scope.keep(block(w, d, h).subtract(core));
      }
      if (!f) return block(w, d, h);
      // 모서리 처리 = 볼록 껍질(hull). 서버 OCCT 필렛·모따기와 같은 형상임을 측정으로 확인함 (docs/architecture.md)
      const r = f.size;
      const corners = (fn: (x: number, y: number) => Manifold[]) =>
        [-1, 1].flatMap((sx) => [-1, 1].flatMap((sy) => fn(sx * (w / 2 - r), sy * (d / 2 - r))));
      let parts: Manifold[];
      if (f.type === 'fillet' && f.edges === 'all') {
        const n = sphereSegments(r, tol);
        parts = corners((x, y) => [r, h - r].map((z) => scope.keep(scope.keep(Manifold.sphere(r, n)).translate([x, y, z]))));
      } else if (f.type === 'fillet') {
        const n = circularSegments(r, tol);
        parts = corners((x, y) => [scope.keep(scope.keep(Manifold.cylinder(h, r, r, n)).translate([x, y, 0]))]);
      } else if (f.edges === 'all') {
        parts = [block(w, d - 2 * r, h - 2 * r, r), block(w - 2 * r, d, h - 2 * r, r), block(w - 2 * r, d - 2 * r, h)];
      } else {
        parts = [block(w, d - 2 * r, h), block(w - 2 * r, d, h)];
      }
      return scope.keep(Manifold.hull(parts));
    }
    case 'cylinder': {
      const { radius: r, height: h } = obj.params;
      const n = circularSegments(r, tol);
      const outer = scope.keep(Manifold.cylinder(h, r, r, n));
      if (!obj.shell) return outer;
      const t = obj.shell.thickness;
      const z0 = obj.shell.open.includes('bottom') ? -1 : t;
      const z1 = obj.shell.open.includes('top') ? h + 1 : h - t;
      const core = scope.keep(scope.keep(Manifold.cylinder(z1 - z0, r - t, r - t, n)).translate([0, 0, z0]));
      return scope.keep(outer.subtract(core));
    }
    case 'hole': {
      // 구멍 도구: 바닥(z 0)부터 depth 까지 지름 diameter, 위쪽에 카운터보어 또는 90° 카운터싱크
      const p = obj.params;
      const r = p.diameter / 2;
      const parts = [scope.keep(Manifold.cylinder(p.depth, r, r, circularSegments(r, tol)))];
      if (p.cboreDiameter > 0) {
        const R = p.cboreDiameter / 2;
        parts.push(scope.keep(scope.keep(Manifold.cylinder(p.cboreDepth, R, R, circularSegments(R, tol))).translate([0, 0, p.depth - p.cboreDepth])));
      }
      if (p.csinkDiameter > 0) {
        const R = p.csinkDiameter / 2;
        const ch = R - r; // 90°: 높이 = 반지름 차
        parts.push(scope.keep(scope.keep(Manifold.cylinder(ch, r, R, circularSegments(R, tol))).translate([0, 0, p.depth - ch])));
      }
      return parts.length === 1 ? parts[0]! : scope.keep(Manifold.union(parts));
    }
    case 'cone': {
      const { radiusBottom: r1, radiusTop: r2, height: h } = obj.params;
      return scope.keep(Manifold.cylinder(h, r1, r2, circularSegments(Math.max(r1, r2), tol)));
    }
    case 'sphere': {
      const r = obj.params.radius;
      return scope.keep(scope.keep(Manifold.sphere(r, sphereSegments(r, tol))).translate([0, 0, r]));
    }
    case 'boolean': {
      const placed = (id: ObjectId) => {
        const child = index.get(id);
        if (!child) throw new GeometryError(`존재하지 않는 객체입니다: ${id}`);
        const local = localManifold(wasm, child, index, tol, scope, sketches);
        return scope.keep(local.transform(toMatrix(child.transform).elements as unknown as Parameters<Manifold['transform']>[0]));
      };
      let result = placed(obj.boolean.base);
      for (const toolId of obj.boolean.tools) {
        const toolObj = index.get(toolId);
        if (toolObj && isSuppressed(toolObj, index)) continue; // 억제된 도구는 이 연산에서만 빠진다
        const tool = placed(toolId);
        const op = obj.boolean.operation;
        result = scope.keep(op === 'cut' ? result.subtract(tool) : op === 'union' ? result.add(tool) : result.intersect(tool));
      }
      const label = OPERATION_LABEL[obj.boolean.operation];
      if (result.status() !== 'NoError') throw new GeometryError(`'${obj.name}': ${label} 결과 형상이 올바르지 않습니다`);
      if (result.isEmpty()) throw new GeometryError(`'${obj.name}': ${label} 결과가 비어 있습니다 (겹치는 부분이 없습니다)`);
      return result;
    }
    case 'pattern': {
      const src = index.get(obj.pattern.source);
      if (!src) throw new GeometryError(`존재하지 않는 객체입니다: ${obj.pattern.source}`);
      const placedSrc = scope.keep(
        localManifold(wasm, src, index, tol, scope, sketches).transform(toMatrix(src.transform).elements as unknown as Parameters<Manifold['transform']>[0]),
      );
      const copies = patternMatrices(obj.pattern).map((m) => scope.keep(placedSrc.transform(m.elements as unknown as Parameters<Manifold['transform']>[0])));
      const result = scope.keep(Manifold.union(copies));
      if (result.status() !== 'NoError') throw new GeometryError(`'${obj.name}': 패턴 결과 형상이 올바르지 않습니다`);
      return result;
    }
  }
}

/** 슬롯 단면: 두 반원(지름 = 폭)의 볼록 껍질을 방향만큼 돌려 중심에 놓는다 (CadQuery slot2D 와 같은 형상) */
function slotSection(wasm: ManifoldToplevel, p: Extract<Profile, { type: 'slot' }>, tol: number, scope: Scope) {
  const { CrossSection } = wasm;
  const r = p.width / 2;
  const n = circularSegments(r, tol);
  const ends = [-p.length / 2, p.length / 2].map((x) => scope.keep(scope.keep(CrossSection.circle(r, n)).translate([x, 0])));
  const hull = scope.keep(CrossSection.hull(ends));
  return scope.keep(scope.keep(hull.rotate(p.angle)).translate(p.center));
}

export function worldManifold(
  wasm: ManifoldToplevel,
  obj: CadObject,
  index: Map<ObjectId, CadObject>,
  tol: number,
  scope: Scope,
  sketches: Map<ObjectId, Sketch> = new Map(),
): Manifold {
  const local = localManifold(wasm, obj, index, tol, scope, sketches);
  return scope.keep(local.transform(toMatrix(obj.transform).elements as unknown as Parameters<Manifold['transform']>[0]));
}

export interface PlainMesh {
  positions: Float32Array;
  indices: Uint32Array;
}

export function toPlainMesh(m: Manifold): PlainMesh {
  const mesh = m.getMesh();
  if (mesh.numProp !== 3) throw new GeometryError('예상하지 못한 메시 형식입니다');
  return { positions: Float32Array.from(mesh.vertProperties), indices: Uint32Array.from(mesh.triVerts) };
}

/** 설계 원본 검증 (서버 check_model 과 같은 그래프 규칙). 문제 목록을 반환한다. */
export function modelIssues(model: ModelDefinition): string[] {
  return validateGraph(model);
}

/** 최상위 객체별 로컬 메시 (서버 /api/model/evaluate 와 같은 계약) */
export function evaluateMeshes(wasm: ManifoldToplevel, model: ModelDefinition, tol = DISPLAY_TOLERANCE) {
  const index = byId(model);
  const sketches = sketchIndex(model);
  const scope = new Scope();
  try {
    return topLevelObjects(model).filter((obj) => !isSuppressed(obj, index)).map((obj) => ({
      objectId: obj.id,
      ...toPlainMesh(localManifold(wasm, obj, index, tol, scope, sketches)),
    }));
  } finally {
    scope.dispose();
  }
}

/** 최상위 객체별 월드 좌표 메시 (내보내기용) */
export function worldMeshes(wasm: ManifoldToplevel, model: ModelDefinition, tol = EXPORT_TOLERANCE) {
  const index = byId(model);
  const sketches = sketchIndex(model);
  const scope = new Scope();
  try {
    return topLevelObjects(model).filter((obj) => !isSuppressed(obj, index)).map((obj) => ({
      name: obj.name,
      ...toPlainMesh(worldManifold(wasm, obj, index, tol, scope, sketches)),
    }));
  } finally {
    scope.dispose();
  }
}

