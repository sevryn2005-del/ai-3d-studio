/**
 * 스케치 지능형 치수 (솔리드웍스 Smart Dimension) — 순수 함수: 무엇을 클릭했는지, 어떤 치수가 되는지, 어떤 명령인지.
 *
 * 고른 대상에 따라 자동으로:
 * - 원 하나 → 지름 (요소 치수 `원ID.diameter`)
 * - 사각형 변 → 폭(아래·위 변)·높이(오른쪽·왼쪽 변) 요소 치수
 * - 다각형·구성선·경로 변 → 길이 구속 (`length`)
 * - 점 두 개 → 거리 구속 (`distance`)
 * - 변 두 개 → 각도 구속 (`angle`, 첫 변 → 둘째 변 반시계, 0~180°)
 * 같은 대상에 이미 같은 치수가 있으면 새로 만들지 않고 그 값을 고친다 (set_constraint / set_dimension).
 * 결과는 기존 명령이라 실행 취소·AI·저장 형식이 그대로다.
 */
import type { CadCommand, Point2, Sketch } from './commandTypes';
import { refKind, sketchPoints } from './solver';
import { dimensionValue } from './sketch';

export type DimKind = 'point' | 'edge' | 'circle';
export interface DimTarget {
  ref: string;
  kind: DimKind;
  /** 화면 표시용: 점 = 그 점, 변 = [a, b], 원 = 중심 + 반지름 */
  a: Point2;
  b?: Point2;
  r?: number;
}

export type DimPlan =
  | { type: 'constraint'; constraint: 'length' | 'distance' | 'angle'; refs: string[]; value: number; existing?: string; label: string }
  | { type: 'dimension'; dimension: string; value: number; label: string }
  | { type: 'error'; message: string };

const RECT: Point2[] = [[-1, -1], [1, -1], [1, 1], [-1, 1]];

/** 스케치의 모든 점 (사각형 모서리 포함) */
function allPoints(sketch: Sketch): Map<string, Point2> {
  const pts = sketchPoints(sketch);
  for (const e of sketch.entities) {
    if (e.type !== 'rectangle') continue;
    const w = dimensionValue(sketch, e.id, 'width') ?? 0;
    const h = dimensionValue(sketch, e.id, 'height') ?? 0;
    RECT.forEach(([sx, sy], k) => pts.set(`${e.id}.p${k}`, [e.center[0] + (sx! * w) / 2, e.center[1] + (sy! * h) / 2]));
  }
  return pts;
}

/** 스케치의 모든 변 [이름, 시작, 끝] */
function allEdges(sketch: Sketch, pts: Map<string, Point2>): [string, Point2, Point2][] {
  const out: [string, Point2, Point2][] = [];
  for (const e of sketch.entities) {
    if (e.type === 'rectangle') {
      for (let k = 0; k < 4; k++) out.push([`${e.id}.e${k}`, pts.get(`${e.id}.p${k}`)!, pts.get(`${e.id}.p${(k + 1) % 4}`)!]);
    } else if (e.type === 'polygon' || e.type === 'line' || e.type === 'path') {
      const n = e.points.length;
      const count = e.type === 'polygon' ? n : n - 1;
      for (let k = 0; k < count; k++) out.push([`${e.id}.e${k}`, e.points[k]!, e.points[(k + 1) % n]!]);
    }
  }
  return out;
}

function segDist(p: Point2, a: Point2, b: Point2): number {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const l2 = dx * dx + dy * dy;
  const t = l2 > 0 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

/** 커서 p 근처 대상 (점 → 변 → 원 순으로 우선, tol = 화면 몇 픽셀의 mm) */
export function hitTarget(sketch: Sketch, p: Point2, tol: number): DimTarget | null {
  const pts = allPoints(sketch);
  let best: DimTarget | null = null;
  let bestD = tol;
  for (const [ref, q] of pts) {
    if (!refKind(sketch, ref)) continue;
    const d = Math.hypot(p[0] - q[0], p[1] - q[1]);
    if (d <= bestD) {
      bestD = d;
      best = { ref, kind: 'point', a: q };
    }
  }
  if (best) return best;
  bestD = tol;
  for (const [ref, a, b] of allEdges(sketch, pts)) {
    const d = segDist(p, a, b);
    if (d <= bestD) {
      bestD = d;
      best = { ref, kind: 'edge', a, b };
    }
  }
  if (best) return best;
  bestD = tol;
  for (const e of sketch.entities) {
    if (e.type !== 'circle') continue;
    const r = (dimensionValue(sketch, e.id, 'diameter') ?? 0) / 2;
    const d = Math.abs(Math.hypot(p[0] - e.center[0], p[1] - e.center[1]) - r);
    if (d <= bestD) {
      bestD = d;
      best = { ref: e.id, kind: 'circle', a: e.center, r };
    }
  }
  return best;
}

const round = (v: number, k = 1000) => Math.round(v * k) / k;
/** 요소 치수 ID (보통 "요소ID.종류") */
const dimId = (sketch: Sketch, entity: string, kind: string) => sketch.dimensions.find((d) => d.entity === entity && d.kind === kind)?.id ?? `${entity}.${kind}`;
const sameSet = (x: readonly string[], y: readonly string[]) => x.length === y.length && x.every((r) => y.includes(r));

/** 고른 대상으로 만들 치수 */
export function planDimension(sketch: Sketch, targets: DimTarget[]): DimPlan {
  const kinds = targets.map((t) => t.kind).join('+');
  const refs = targets.map((t) => t.ref);
  const existing = (type: string) => sketch.constraints.find((c) => c.type === type && sameSet(c.refs, refs))?.id;
  if (kinds === 'circle') {
    const id = refs[0]!;
    return { type: 'dimension', dimension: dimId(sketch, id, 'diameter'), value: round((dimensionValue(sketch, id, 'diameter') ?? 0)), label: '지름' };
  }
  if (kinds === 'edge') {
    const t = targets[0]!;
    const [id, part] = t.ref.split('.') as [string, string];
    const e = sketch.entities.find((x) => x.id === id);
    if (e?.type === 'rectangle') {
      const kind = part === 'e0' || part === 'e2' ? 'width' : 'height';
      return { type: 'dimension', dimension: dimId(sketch, id, kind), value: round(dimensionValue(sketch, id, kind) ?? 0), label: kind === 'width' ? '폭' : '높이' };
    }
    const len = Math.hypot(t.b![0] - t.a[0], t.b![1] - t.a[1]);
    return { type: 'constraint', constraint: 'length', refs, value: round(len), existing: existing('length'), label: '길이' };
  }
  if (kinds === 'point+point') {
    if (refs[0] === refs[1]) return { type: 'error', message: '서로 다른 두 점을 고르세요' };
    const [a, b] = [targets[0]!.a, targets[1]!.a];
    const d = Math.hypot(b[0] - a[0], b[1] - a[1]);
    if (d < 1e-6) return { type: 'error', message: '두 점이 같은 자리에 있어 거리를 잴 수 없습니다 (일치 구속을 쓰세요)' };
    return { type: 'constraint', constraint: 'distance', refs, value: round(d), existing: existing('distance'), label: '거리' };
  }
  if (kinds === 'edge+edge') {
    if (refs[0] === refs[1]) return { type: 'error', message: '서로 다른 두 변을 고르세요' };
    const u = [targets[0]!.b![0] - targets[0]!.a[0], targets[0]!.b![1] - targets[0]!.a[1]];
    const v = [targets[1]!.b![0] - targets[1]!.a[0], targets[1]!.b![1] - targets[1]!.a[1]];
    let deg = (Math.atan2(u[0]! * v[1]! - u[1]! * v[0]!, u[0]! * v[0]! + u[1]! * v[1]!) * 180) / Math.PI;
    deg = ((deg % 180) + 180) % 180;
    if (deg < 1e-3 || deg > 180 - 1e-3) return { type: 'error', message: '평행한 두 변은 각도를 잴 수 없습니다 (평행 구속을 쓰세요)' };
    return { type: 'constraint', constraint: 'angle', refs, value: round(deg), existing: existing('angle'), label: '각도' };
  }
  return { type: 'error', message: '치수는 변 하나(길이)·원(지름)·점 두 개(거리)·변 두 개(각도)로 만듭니다' };
}

/** 계획 + 입력값 → 명령 */
export function dimensionCommand(sketch: Sketch, plan: Exclude<DimPlan, { type: 'error' }>, value: number): CadCommand {
  if (plan.type === 'dimension') return { type: 'set_dimension', sketch: sketch.id, dimension: plan.dimension, value };
  if (plan.existing) return { type: 'set_constraint', sketch: sketch.id, constraint: plan.existing, value };
  return { type: 'add_constraint', sketch: sketch.id, constraint: plan.constraint, refs: plan.refs, value };
}

/** 이 대상 하나만으로 치수가 정해지는가 (원) — 아니면 다음 클릭을 기다린다 */
export const completesAlone = (t: DimTarget) => t.kind === 'circle';
