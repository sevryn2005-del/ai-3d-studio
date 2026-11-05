/**
 * 조립 메이트 (형식 v11, 솔리드웍스 Mate / 인벤터 Constrain).
 *
 * 메이트는 최상위 객체(부품)들의 변환만 정한다 → CAD 엔진은 바뀌지 않는다 (저장된 변환 = 푼 결과, 스케치 구속과 같은 원칙).
 * 서버 backend/app/cad/mates.py 가 같은 잔차로 저장된 결과가 메이트를 만족하는지 검사한다.
 *
 * 참조: "객체ID.면이름"(평면: 원점 = 면 중심, 방향 = 바깥 법선) 또는 "객체ID.axis"(축: 원점 + 방향), fix 는 "객체ID".
 * 잔차 (A = 첫 참조, B = 둘째 참조, n = 방향, o = 원점)
 * - coincident: 면이 마주 닿음 n_A + n_B = 0 (flip: 같은 방향 n_A − n_B = 0), (o_B − o_A)·n_A = 0
 * - distance: coincident 와 같고 (o_B − o_A)·n_A = value
 * - parallel: n_A × n_B = 0 · perpendicular: n_A·n_B = 0 · angle: n_A·n_B = cos(value)
 * - concentric: 축 방향 d_A × d_B = 0, B 원점이 A 축 위 (o_B − o_A) × d_A = 0
 * - fix: 고정 (풀이에서 움직이지 않음)
 * 풀이: 고정·이번에 사용자가 옮긴 객체 외에는 위치·회전 6개 값을 최소 이동 가우스-뉴턴으로 (solver.ts 와 같은 방법).
 * 메이트로 이어진 무리에 고정이 없으면 모델 순서상 첫 객체를 고정한다 (솔리드웍스: 처음 넣은 부품 고정).
 */
import { Matrix4, Quaternion, Vector3 } from 'three';
import type { CadObject, FaceName, Mate, MateRef, ModelDefinition, ObjectId } from './commandTypes';
import { extrudeLocalMatrix, faceLocalMatrix, facesOf } from './sketchPlane';
import { findSketch, profileOf } from './sketch';
import { topLevelObjects } from './modelGraph';
import { fromMatrix, toMatrix } from './transformMath';
import { jacobian, minimalMoveSolve, rank } from './solver';

export const MATE_LABEL: Record<Mate['type'], string> = {
  coincident: '일치',
  distance: '거리',
  parallel: '평행',
  perpendicular: '직각',
  angle: '각도',
  concentric: '동심',
  fix: '고정',
};

/** 메이트 만족 허용 오차 (저장값 반올림 포함) — 서버 mates.CHECK_TOLERANCE 와 같음 */
export const MATE_TOLERANCE = 1e-4;
/** 회전 값의 길이 환산 (최소 이동 풀이에서 회전 1 rad ≈ 100mm 이동으로 본다) */
const ROT_SCALE = 100;
const MAX_DEPTH = 32;

interface Frame {
  origin: Vector3;
  dir: Vector3;
}

/** 객체 로컬 축 (원통·원뿔·구멍 = 로컬 Z, 원 돌출 = 원 중심 법선, 회전·헬릭스 = 스케치 v 축). 없으면 null */
export function axisLocal(model: ModelDefinition, obj: CadObject, depth = 0): Frame | null {
  if (depth > MAX_DEPTH) return null;
  const via = (id: ObjectId) => {
    const child = model.objects.find((o) => o.id === id);
    const f = child ? axisLocal(model, child, depth + 1) : null;
    if (!child || !f) return null;
    const m = toMatrix(child.transform);
    return { origin: f.origin.clone().applyMatrix4(m), dir: f.dir.clone().transformDirection(m) };
  };
  switch (obj.kind) {
    case 'cylinder':
    case 'cone':
    case 'hole':
      return { origin: new Vector3(), dir: new Vector3(0, 0, 1) };
    case 'extrude': {
      const sk = findSketch(model, obj.extrude.sketch);
      const p = sk ? profileOf(sk, obj.extrude) : null;
      const m = extrudeLocalMatrix(model, obj, depth + 1);
      if (!p || !m || (p.type !== 'circle' && p.type !== 'slot')) return null;
      return { origin: new Vector3(p.center[0], p.center[1], 0).applyMatrix4(m), dir: new Vector3(0, 0, 1).transformDirection(m) };
    }
    case 'revolve':
    case 'helix': {
      const m = extrudeLocalMatrix(model, obj, depth + 1);
      return m ? { origin: new Vector3().applyMatrix4(m), dir: new Vector3(0, 1, 0).transformDirection(m) } : null;
    }
    case 'boolean':
      return via(obj.boolean.base);
    case 'pattern':
      return obj.pattern.type === 'scale' ? null : via(obj.pattern.source);
    case 'fillet':
      return via(obj.fillet.source);
    case 'draft':
      return via(obj.draft.source);
    default:
      return null;
  }
}

/** 메이트에 쓸 수 있는 참조 (면 + 축) */
export function mateRefsOf(model: ModelDefinition, obj: CadObject): string[] {
  const faces = facesOf(model, obj).map((f) => `${obj.id}.${f}`);
  return axisLocal(model, obj) ? [...faces, `${obj.id}.axis`] : faces;
}

function localFrame(model: ModelDefinition, obj: CadObject, part: string): Frame | null {
  if (part === 'axis') return axisLocal(model, obj);
  const m = faceLocalMatrix(model, obj, part as FaceName);
  return m ? { origin: new Vector3().setFromMatrixPosition(m), dir: new Vector3(0, 0, 1).transformDirection(m) } : null;
}

/** 참조 → [객체, 면 이름 | 'axis' | '' (고정) | '@face' · '@axis' (화면에서 고른 이름 없는 면·축)] */
const split = (ref: MateRef): [ObjectId, string] => {
  if (typeof ref !== 'string') return [ref.object, `@${ref.kind}`];
  const i = ref.indexOf('.');
  return i < 0 ? [ref, ''] : [ref.slice(0, i), ref.slice(i + 1)];
};
export const refObject = (ref: MateRef): ObjectId => split(ref)[0];
export const isAxisRef = (ref: MateRef) => (typeof ref === 'string' ? ref.endsWith('.axis') : ref.kind === 'axis');

/** 참조의 객체 로컬 좌표계 (원점, 방향). 고른 면·축은 저장된 값, 이름 면은 지금 치수로 계산 */
function refLocalFrame(model: ModelDefinition, obj: CadObject, ref: MateRef): Frame | null {
  if (typeof ref !== 'string') {
    const dir = new Vector3(...ref.dir);
    return dir.length() > 1e-9 ? { origin: new Vector3(...ref.origin), dir: dir.normalize() } : null;
  }
  return localFrame(model, obj, split(ref)[1]);
}

/** 메이트 형식 검사. 문제가 없으면 null */
export function mateError(model: ModelDefinition, m: Pick<Mate, 'type' | 'refs' | 'value'>): string | null {
  const tops = new Set(topLevelObjects(model).map((o) => o.id));
  const need = m.type === 'fix' ? 1 : 2;
  if (m.refs.length !== need) return `${MATE_LABEL[m.type]} 메이트는 참조가 ${need}개입니다`;
  for (const ref of m.refs) {
    const [id, part] = split(ref);
    const obj = model.objects.find((o) => o.id === id);
    if (!obj) return `존재하지 않는 객체입니다: ${id}`;
    if (!tops.has(id)) return `'${obj.name}'은(는) 다른 객체에 포함되어 있습니다. 메이트는 최상위 객체(부품)끼리 겁니다`;
    if (m.type === 'fix') {
      if (part) return '고정 메이트는 객체 ID 만 참조합니다';
      continue;
    }
    if (!part) return `${id}: 면 또는 축을 지정하세요 (예: ${id}.top, ${id}.axis)`;
    if (!refLocalFrame(model, obj, ref)) return `'${obj.name}'에는 ${part === 'axis' ? '축' : `'${part}' 면`}이 없습니다 (쓸 수 있는 것: ${mateRefsOf(model, obj).map((r) => split(r)[1]).join(', ') || '없음'})`;
    const isAxis = isAxisRef(ref);
    if ((m.type === 'coincident' || m.type === 'distance') && isAxis) return `${MATE_LABEL[m.type]} 메이트는 면끼리 겁니다 (축은 동심)`;
    if (m.type === 'concentric' && !isAxis) return '동심 메이트는 축끼리 겁니다 (예: cylinder_1.axis)';
  }
  if (m.type !== 'fix' && refObject(m.refs[0]!) === refObject(m.refs[1]!)) return '같은 객체끼리는 메이트를 걸 수 없습니다';
  if ((m.type === 'distance' || m.type === 'angle') && m.value === undefined) return `${MATE_LABEL[m.type]} 메이트에는 값이 필요합니다`;
  return null;
}

type WorldOf = (id: ObjectId) => Matrix4;

function residuals(model: ModelDefinition, m: Mate, world: WorldOf): number[] {
  if (m.type === 'fix') return [];
  const fr = m.refs.map((ref) => {
    const id = refObject(ref);
    const obj = model.objects.find((o) => o.id === id)!;
    const f = refLocalFrame(model, obj, ref)!;
    const w = world(id);
    return { o: f.origin.clone().applyMatrix4(w), n: f.dir.clone().transformDirection(w) };
  });
  const [A, B] = fr as [{ o: Vector3; n: Vector3 }, { o: Vector3; n: Vector3 }];
  const d = B.o.clone().sub(A.o);
  switch (m.type) {
    case 'coincident':
    case 'distance': {
      const nn = m.flip ? A.n.clone().sub(B.n) : A.n.clone().add(B.n);
      return [nn.x, nn.y, nn.z, d.dot(A.n) - (m.type === 'distance' ? (m.value ?? 0) : 0)];
    }
    case 'parallel': {
      const c = A.n.clone().cross(B.n);
      return [c.x, c.y, c.z];
    }
    case 'perpendicular':
      return [A.n.dot(B.n)];
    case 'angle':
      return [A.n.dot(B.n) - Math.cos(((m.value ?? 0) * Math.PI) / 180)];
    case 'concentric': {
      const c = A.n.clone().cross(B.n);
      const e = d.cross(A.n);
      return [c.x, c.y, c.z, e.x, e.y, e.z];
    }
  }
}

/** 저장된 변환에서 각 메이트의 최대 잔차 */
export function mateResiduals(model: ModelDefinition): Map<string, number> {
  const out = new Map<string, number>();
  const world: WorldOf = (id) => toMatrix(model.objects.find((o) => o.id === id)!.transform);
  for (const m of model.mates ?? []) {
    if (mateError(model, m)) continue;
    out.set(m.id, Math.max(0, ...residuals(model, m, world).map(Math.abs)));
  }
  return out;
}

/** 움직이지 않는 객체: 고정 메이트 + pinned + (고정이 없는 무리마다) 모델 순서상 첫 객체 */
function grounded(model: ModelDefinition, pinned: ReadonlySet<ObjectId>): { movers: ObjectId[]; fixed: Set<ObjectId> } {
  const mates = model.mates ?? [];
  const order = new Map(model.objects.map((o, i) => [o.id, i]));
  const parent = new Map<ObjectId, ObjectId>();
  const find = (a: ObjectId): ObjectId => {
    while (parent.get(a) !== a) a = parent.get(a)!;
    return a;
  };
  const ids = new Set<ObjectId>();
  for (const m of mates) for (const r of m.refs) ids.add(refObject(r));
  for (const id of ids) parent.set(id, id);
  for (const m of mates) if (m.refs.length === 2) parent.set(find(refObject(m.refs[0]!)), find(refObject(m.refs[1]!)));
  const fixed = new Set<ObjectId>([...pinned].filter((id) => ids.has(id)));
  for (const m of mates) if (m.type === 'fix') fixed.add(refObject(m.refs[0]!));
  const groups = new Map<ObjectId, ObjectId[]>();
  for (const id of ids) groups.set(find(id), [...(groups.get(find(id)) ?? []), id]);
  for (const members of groups.values()) {
    if (members.some((id) => fixed.has(id))) continue;
    fixed.add(members.sort((a, b) => order.get(a)! - order.get(b)!)[0]!);
  }
  return { movers: [...ids].filter((id) => !fixed.has(id)).sort((a, b) => order.get(a)! - order.get(b)!), fixed };
}

function makeWorld(model: ModelDefinition, movers: ObjectId[], x: number[]): WorldOf {
  const base = new Map(model.objects.map((o) => [o.id, toMatrix(o.transform)]));
  const slot = new Map(movers.map((id, i) => [id, i]));
  return (id) => {
    const m0 = base.get(id)!;
    const i = slot.get(id);
    if (i === undefined) return m0;
    const t = new Vector3(x[6 * i]!, x[6 * i + 1]!, x[6 * i + 2]!);
    const r = new Vector3(x[6 * i + 3]!, x[6 * i + 4]!, x[6 * i + 5]!).divideScalar(ROT_SCALE);
    const angle = r.length();
    const dq = angle > 0 ? new Quaternion().setFromAxisAngle(r.clone().normalize(), angle) : new Quaternion();
    const p = new Vector3();
    const q = new Quaternion();
    const s = new Vector3();
    m0.decompose(p, q, s);
    return new Matrix4().compose(p.add(t), dq.multiply(q), s);
  };
}

export type MateSolve = { ok: true; model: ModelDefinition; dof: number } | { ok: false; error: string };

/**
 * 메이트를 풀어 변환을 반영한다. pinned = 이번 편집에서 사용자가 옮긴 객체(움직이지 않음).
 * 풀 수 없으면 실패 → 실행기가 원본을 그대로 둔다.
 */
export function solveMates(model: ModelDefinition, pinned: ReadonlySet<ObjectId> = new Set()): MateSolve {
  const mates = model.mates ?? [];
  for (const m of mates) {
    const err = mateError(model, m);
    if (err) return { ok: false, error: `메이트 ${m.id}: ${err}` };
  }
  if (!mates.length) return { ok: true, model, dof: 0 };
  const { movers } = grounded(model, pinned);
  const R = (x: number[]) => {
    const w = makeWorld(model, movers, x);
    return mates.flatMap((m) => residuals(model, m, w));
  };
  const x0 = new Array<number>(movers.length * 6).fill(0);
  const { x, r } = minimalMoveSolve(R, x0);
  if (r.some((v) => Math.abs(v) > 1e-5)) return { ok: false, error: '메이트를 동시에 만족할 수 없습니다 (서로 모순되거나 과하게 구속되었습니다)' };
  const w = makeWorld(model, movers, x);
  const moved = new Set(movers);
  const solved: ModelDefinition = {
    ...model,
    objects: model.objects.map((o) => (moved.has(o.id) ? { ...o, transform: fromMatrix(w(o.id)) } : o)),
  };
  const worst = Math.max(0, ...mateResiduals(solved).values());
  if (worst > MATE_TOLERANCE) return { ok: false, error: '메이트를 동시에 만족할 수 없습니다' };
  return { ok: true, model: solved, dof: mateDof(solved) };
}

/** 남은 자유도 = 움직일 수 있는 부품 수 × 6 − 메이트 자코비안 계수. 0 이면 완전 정의 */
export function mateDof(model: ModelDefinition): number {
  const mates = model.mates ?? [];
  if (!mates.length) return 0;
  const { movers } = grounded(model, new Set());
  if (!movers.length) return 0;
  const R = (x: number[]) => {
    const w = makeWorld(model, movers, x);
    return mates.flatMap((m) => residuals(model, m, w));
  };
  const x0 = new Array<number>(movers.length * 6).fill(0);
  const r0 = R(x0);
  if (!r0.length) return movers.length * 6;
  return movers.length * 6 - rank(jacobian(R, x0, r0.length));
}

/** 객체를 참조하는 메이트 ID */
export function matesOf(model: ModelDefinition, id: ObjectId): string[] {
  return (model.mates ?? []).filter((m) => m.refs.some((r) => refObject(r) === id)).map((m) => m.id);
}

/** 삭제된 객체를 참조하는 메이트를 뺀 모델 */
export function pruneMates(model: ModelDefinition): ModelDefinition {
  if (!model.mates?.length) return model;
  const ids = new Set(model.objects.map((o) => o.id));
  const mates = model.mates.filter((m) => m.refs.every((r) => ids.has(refObject(r))));
  return mates.length === model.mates.length ? model : { ...model, mates };
}

