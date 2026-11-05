/**
 * 화면에서 면·모서리 고르기 (형식 v12) — 상태와 순수 계산.
 *
 * 엔진의 위상(CadEngine.topology: B-rep 면·모서리)을 화면에 겹쳐 그리고, 고른 것을 설계 원본의 참조로 바꾼다:
 * - 필렛·모따기: 모서리 가운데 점(mid) → fillet.edges.at (엔진이 그 점을 지나는 모서리를 고른다)
 * - 메이트: 이름 있는 면·축과 같으면 이름 참조("객체.top", "객체.axis" — 치수를 따라감), 아니면 고른 기하(부품 로컬)
 * - 면 위 스케치: 이름 있는 면이면 face 평면(객체를 따라감), 아니면 frame 평면(고정 위치)
 * - 측정: 길이·반지름·두 요소 사이 거리·각도
 * 좌표: 위상은 "객체의 부모 좌표계"(최상위 객체 = 월드). 요청의 frame 은 그 좌표계를 월드로 옮기는 객체(필렛 감싸는 객체).
 */
import { Matrix4, Vector3 } from 'three';
import { create } from 'zustand';
import type { MateRef, ModelDefinition, ObjectId, SketchPlane } from '../../cad/commandTypes';
import { axisLocal } from '../../cad/mates';
import { faceLocalMatrix, facesOf } from '../../cad/sketchPlane';
import { toMatrix } from '../../cad/transformMath';
import type { TopoEdge, TopoFace } from '../engine/types';

export interface PickedEntity {
  objectId: ObjectId;
  kind: 'edge' | 'face';
  index: number;
  edge?: TopoEdge;
  face?: TopoFace;
}

export interface PickRequest {
  purpose: 'fillet' | 'mate' | 'sketch' | 'measure';
  accept: 'edge' | 'face' | 'any';
  /** 위상을 보여 줄 객체 */
  objects: ObjectId[];
  /** 위상 좌표계(부모) → 월드: 이 객체의 월드 행렬. 없으면 월드 */
  frame?: ObjectId;
  /** 고를 수 있는 최대 수. 1 이면 고르는 즉시 끝 */
  max: number;
  hint: string;
  /** 고른 면만 받기 (예: 평면만) */
  filter?: (p: PickedEntity) => string | null;
  /** 처음부터 골라 둘 것 (필렛 편집: 지금 고른 점에 닿는 모서리) */
  preselect?: (objectId: ObjectId, edges: TopoEdge[]) => number[];
  onDone: (picks: PickedEntity[]) => void;
}

interface PickState {
  request: PickRequest | null;
  picks: PickedEntity[];
  /** 위상을 다 불러왔는가 (화면 안내·테스트용) */
  ready: boolean;
  setReady: (ready: boolean) => void;
  /** 마지막으로 고른 시각 — 고르기를 끝낸 그 클릭이 객체 선택으로 이어지지 않게 */
  lastPickAt: number;
  start: (r: PickRequest) => void;
  toggle: (p: PickedEntity) => void;
  setPicks: (p: PickedEntity[]) => void;
  finish: () => void;
  cancel: () => void;
}

const same = (a: PickedEntity, b: PickedEntity) => a.objectId === b.objectId && a.kind === b.kind && a.index === b.index;

export const usePickStore = create<PickState>((set, get) => ({
  request: null,
  picks: [],
  ready: false,
  lastPickAt: 0,
  setReady: (ready) => set({ ready }),
  start: (request) => set({ request, picks: [], ready: false }),
  toggle: (p) => {
    const { request, picks } = get();
    if (!request) return;
    const next = picks.some((x) => same(x, p)) ? picks.filter((x) => !same(x, p)) : [...picks, p].slice(-request.max);
    set({ picks: next, lastPickAt: Date.now() });
    if (request.max === 1 && next.length === 1) get().finish();
  },
  setPicks: (picks) => set({ picks }),
  finish: () => {
    const { request, picks } = get();
    set({ request: null, picks: [] });
    if (request && picks.length) request.onDone(picks);
  },
  cancel: () => set({ request: null, picks: [] }),
}));

const V = (a: readonly number[]) => new Vector3(a[0], a[1], a[2]);
const close = (a: Vector3, b: Vector3, tol = 1e-4) => a.distanceTo(b) < tol;

/** 월드(=최상위 객체의 부모) 기하 → 부품 로컬 */
function toLocal(model: ModelDefinition, objectId: ObjectId) {
  const obj = model.objects.find((o) => o.id === objectId)!;
  const inv = toMatrix(obj.transform).invert();
  return { obj, point: (p: readonly number[]) => V(p).applyMatrix4(inv), dir: (d: readonly number[]) => V(d).transformDirection(inv) };
}

/**
 * 고른 면 → 메이트 참조. 평면 = 면, 원통·원뿔 = 축. 이름 있는 면·축과 같으면 이름 참조(치수를 따라감)
 */
export function faceToMateRef(model: ModelDefinition, objectId: ObjectId, face: TopoFace): MateRef | null {
  const { obj, point, dir } = toLocal(model, objectId);
  const o = point(face.origin);
  const n = dir(face.dir);
  if (face.kind === 'plane') {
    for (const name of facesOf(model, obj)) {
      const m = faceLocalMatrix(model, obj, name);
      if (!m) continue;
      const fo = new Vector3().setFromMatrixPosition(m);
      const fn = new Vector3(0, 0, 1).transformDirection(m);
      if (fn.dot(n) > 1 - 1e-6 && Math.abs(o.clone().sub(fo).dot(fn)) < 1e-4) return `${objectId}.${name}`;
    }
    return { object: objectId, kind: 'face', origin: round3(o), dir: round3(n) };
  }
  if (face.kind === 'cylinder' || face.kind === 'cone') {
    const ax = axisLocal(model, obj);
    if (ax && Math.abs(ax.dir.dot(n)) > 1 - 1e-6 && o.clone().sub(ax.origin).cross(ax.dir).length() < 1e-4) return `${objectId}.axis`;
    return { object: objectId, kind: 'axis', origin: round3(o), dir: round3(n) };
  }
  return null;
}

/** 고른 평면 → 스케치 평면. 이름 있는 면이면 face(따라감), 아니면 frame(월드 고정) */
export function faceToSketchPlane(model: ModelDefinition, objectId: ObjectId, face: TopoFace, world: Matrix4 = new Matrix4()): SketchPlane | null {
  if (face.kind !== 'plane') return null;
  const ref = faceToMateRef(model, objectId, face);
  if (typeof ref === 'string') return { type: 'face', object: objectId, face: ref.slice(objectId.length + 1) as never, offset: 0 };
  const o = V(face.origin).applyMatrix4(world);
  const n = V(face.dir).transformDirection(world);
  // u 방향: 법선에 수직이면서 월드 X(법선이 X 에 가까우면 Y)에 가장 가까운 방향
  const ref2 = Math.abs(n.x) > 0.9 ? new Vector3(0, 1, 0) : new Vector3(1, 0, 0);
  const x = ref2.sub(n.clone().multiplyScalar(ref2.dot(n))).normalize();
  return { type: 'frame', origin: round3(o), normal: round3(n), xDir: round3(x), offset: 0 };
}

const round3 = (v: Vector3): [number, number, number] => [v.x, v.y, v.z].map((c) => Math.round(c * 1e6) / 1e6 + 0) as [number, number, number];

/** 모서리 꺾은선의 점들 */
function edgePoints(e: TopoEdge): Vector3[] {
  const out: Vector3[] = [];
  for (let i = 0; i + 2 < e.points.length; i += 3) out.push(new Vector3(e.points[i], e.points[i + 1], e.points[i + 2]));
  return out;
}

function entityPoints(p: PickedEntity): Vector3[] {
  if (p.edge) return edgePoints(p.edge);
  const pts: Vector3[] = [];
  const pos = p.face!.positions;
  for (let i = 0; i + 2 < pos.length; i += 3) pts.push(new Vector3(pos[i], pos[i + 1], pos[i + 2]));
  return pts;
}

/** 요소의 방향 (평면 법선 / 축 / 직선 방향). 없으면 null */
function entityDir(p: PickedEntity): Vector3 | null {
  if (p.face && (p.face.kind === 'plane' || p.face.kind === 'cylinder' || p.face.kind === 'cone')) return V(p.face.dir).normalize();
  if (p.edge && (p.edge.kind === 'line' || p.edge.kind === 'circle')) return V(p.edge.dir).normalize();
  return null;
}

export interface MeasureLine {
  label: string;
  value: number;
  unit: 'mm' | '°';
}

/** 면·모서리 측정: 한 개면 길이·반지름, 두 개면 거리·각도 (같은 좌표계의 위상끼리) */
export function measureEntities(picks: PickedEntity[]): MeasureLine[] {
  const out: MeasureLine[] = [];
  for (const p of picks) {
    const tag = picks.length > 1 ? ` (${picks.indexOf(p) + 1})` : '';
    if (p.edge?.kind === 'line') out.push({ label: `모서리 길이${tag}`, value: p.edge.length, unit: 'mm' });
    if (p.edge?.kind === 'circle') {
      out.push({ label: `지름${tag}`, value: p.edge.radius * 2, unit: 'mm' });
      if (p.edge.length < 2 * Math.PI * p.edge.radius - 1e-6) out.push({ label: `호 길이${tag}`, value: p.edge.length, unit: 'mm' });
    }
    if (p.edge?.kind === 'other') out.push({ label: `모서리 길이${tag}`, value: p.edge.length, unit: 'mm' });
    if (p.face && (p.face.kind === 'cylinder' || p.face.kind === 'sphere')) out.push({ label: `${p.face.kind === 'sphere' ? '구' : '원통'} 지름${tag}`, value: p.face.radius * 2, unit: 'mm' });
  }
  if (picks.length !== 2) return out;
  const [a, b] = picks as [PickedEntity, PickedEntity];
  const da = entityDir(a);
  const db = entityDir(b);
  if (da && db) {
    const cos = Math.min(1, Math.abs(da.dot(db)));
    const angle = (Math.acos(cos) * 180) / Math.PI;
    out.push({ label: '각도', value: angle, unit: '°' });
    // 평행한 두 평면: 평면 사이 거리. 평행한 두 축: 축 사이 거리
    if (angle < 1e-4) {
      if (a.face?.kind === 'plane' && b.face?.kind === 'plane') {
        out.push({ label: '평면 사이 거리', value: Math.abs(V(b.face.origin).sub(V(a.face.origin)).dot(da)), unit: 'mm' });
        return out;
      }
      const axisPoint = (p: PickedEntity) => (p.face ? V(p.face.origin) : p.edge?.kind === 'circle' ? V(p.edge.center) : null);
      const pa = axisPoint(a);
      const pb = axisPoint(b);
      if (pa && pb && (a.face?.kind !== 'plane') && (b.face?.kind !== 'plane')) {
        out.push({ label: '축 사이 거리', value: pb.clone().sub(pa).cross(da).length(), unit: 'mm' });
        return out;
      }
    }
  }
  // 그 밖: 두 요소의 가장 가까운 표본점 사이 거리 (면은 삼각형 꼭짓점, 모서리는 곡선 위 점)
  let best = Infinity;
  for (const p of entityPoints(a)) for (const q of entityPoints(b)) best = Math.min(best, p.distanceTo(q));
  if (Number.isFinite(best)) out.push({ label: '최소 거리 (근사)', value: best, unit: 'mm' });
  return out;
}

/** 필렛 편집: 지금 고른 점(at)에 닿는 모서리 번호 */
export function edgesAt(edges: TopoEdge[], at: readonly (readonly number[])[]): number[] {
  const pts = at.map(V);
  return edges
    .map((e, i) => ({ i, pts: edgePoints(e) }))
    .filter(({ pts: ep }) =>
      pts.some((p) => ep.some((q, k) => k > 0 && distToSegment(p, ep[k - 1]!, q) < 1e-3) || ep.some((q) => close(p, q, 1e-3))),
    )
    .map(({ i }) => i);
}

function distToSegment(p: Vector3, a: Vector3, b: Vector3): number {
  const ab = b.clone().sub(a);
  const t = Math.max(0, Math.min(1, p.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-18)));
  return a.clone().add(ab.multiplyScalar(t)).distanceTo(p);
}

/** 고르는 중이거나 방금 고른 클릭인가 (객체 선택·선택 해제를 건너뛴다) */
export const pickBusy = () => {
  const s = usePickStore.getState();
  return !!s.request || Date.now() - s.lastPickAt < 400;
};
