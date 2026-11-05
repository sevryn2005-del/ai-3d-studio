/**
 * 스케치 잘라내기·연장 (솔리드웍스 Trim / Extend) — 순수 함수. 대상: 구성선(line)·경로(path)의 곧은 변.
 * 잘라내기: 누른 변에서, 누른 자리 양옆의 가장 가까운 교차점 사이 조각을 지운다 (교차점이 없으면 변 전체).
 * 연장: 누른 끝점을 그 변 방향으로 가장 가까운 다른 요소까지 늘인다.
 * 결과는 기존 명령(delete_sketch_entity·add_line·add_path·move_point)이라 저장 형식 그대로.
 * 다른 요소 윤곽: 원은 정확한 식, 나머지(사각형·다각형·호·스플라인·슬롯·타원)는 촘촘한 꺾은선.
 */
import type { CadCommand, Point2, Sketch, SketchEntity } from './commandTypes';
import { dimensionValue, ellipseOutline, slotOutline } from './sketch';
import { roundedPoints } from './curves';

type Seg = { a: Point2; b: Point2; owner: string; k: number };
type Circ = { c: Point2; r: number; owner: string };

const EPS = 1e-9;
const sub = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const cross = (a: Point2, b: Point2) => a[0] * b[1] - a[1] * b[0];
const lerp = (a: Point2, b: Point2, t: number): Point2 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
const rp = (p: Point2): Point2 => [r6(p[0]), r6(p[1])];

/** 잘라내기·연장할 수 있는 선: 장식 없는(호·꼭짓점 처리·스플라인 없는) 구성선·경로 */
export function trimmable(e: SketchEntity): e is Extract<SketchEntity, { type: 'line' | 'path' }> {
  return e.type === 'line' || (e.type === 'path' && !e.spline && !e.arcs?.length && !e.corners?.length);
}

function outlines(sketch: Sketch): { segs: Seg[]; circles: Circ[] } {
  const segs: Seg[] = [];
  const circles: Circ[] = [];
  const poly = (owner: string, pts: Point2[], closed: boolean) => {
    for (let k = 0; k + (closed ? 0 : 1) < pts.length; k++) segs.push({ a: pts[k]!, b: pts[(k + 1) % pts.length]!, owner, k });
  };
  for (const e of sketch.entities) {
    const dim = (k: 'width' | 'height' | 'diameter' | 'length') => dimensionValue(sketch, e.id, k) ?? 0;
    if (e.type === 'circle') circles.push({ c: e.center, r: dim('diameter') / 2, owner: e.id });
    else if (e.type === 'rectangle') {
      const [w, h] = [dim('width') / 2, dim('height') / 2];
      const [x, y] = e.center;
      poly(e.id, [[x - w, y - h], [x + w, y - h], [x + w, y + h], [x - w, y + h]], true);
    } else if (e.type === 'line') poly(e.id, [...e.points], false);
    else if (e.type === 'path' || e.type === 'polygon') {
      const plain = !e.spline && !e.arcs?.length && !e.corners?.length;
      poly(e.id, plain ? e.points : roundedPoints(e.points, e.corners, e.type === 'polygon', undefined, e.arcs, e.spline), e.type === 'polygon');
    } else if (e.type === 'slot') poly(e.id, slotOutline({ center: e.center, angle: e.angle, length: dim('length'), width: dim('width') }, 48), true);
    else if (e.type === 'ellipse') poly(e.id, ellipseOutline({ center: e.center, angle: e.angle, width: dim('width'), height: dim('height') }, 128), true);
  }
  return { segs, circles };
}

/** 선분 a→b 위 다른 요소와의 교차 매개변수 t (0~1 안, 정렬) */
function crossings(a: Point2, b: Point2, self: { owner: string; k: number }, o: ReturnType<typeof outlines>, extend = false): number[] {
  const d = sub(b, a);
  const ts: number[] = [];
  const inRange = (t: number) => (extend ? t > 1e-6 : t > 1e-6 && t < 1 - 1e-6);
  for (const s of o.segs) {
    if (s.owner === self.owner && Math.abs(s.k - self.k) <= 1) continue; // 자기 변·이웃 변(이음점)은 빼고
    const e = sub(s.b, s.a);
    const den = cross(d, e);
    if (Math.abs(den) < EPS) continue;
    const w = sub(s.a, a);
    const t = cross(w, e) / den;
    const u = cross(w, d) / den;
    if (inRange(t) && u >= -1e-9 && u <= 1 + 1e-9) ts.push(t);
  }
  for (const c of o.circles) {
    const f = sub(a, c.c);
    const A = d[0] * d[0] + d[1] * d[1];
    const B = 2 * (f[0] * d[0] + f[1] * d[1]);
    const C = f[0] * f[0] + f[1] * f[1] - c.r * c.r;
    const disc = B * B - 4 * A * C;
    if (disc < 0 || A < EPS) continue;
    for (const s of [-1, 1]) {
      const t = (-B + s * Math.sqrt(disc)) / (2 * A);
      if (inRange(t)) ts.push(t);
    }
  }
  return ts.sort((x, y) => x - y);
}

function pointSegDist(p: Point2, a: Point2, b: Point2): { d: number; t: number } {
  const ab = sub(b, a);
  const l2 = ab[0] * ab[0] + ab[1] * ab[1];
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1]) / l2)) : 0;
  const q = lerp(a, b, t);
  return { d: Math.hypot(p[0] - q[0], p[1] - q[1]), t };
}

export interface TrimHit {
  entity: string;
  k: number;
  t1: number;
  t2: number;
  piece: [Point2, Point2];
}

/** 커서 p 근처(tol mm)의 잘라낼 조각 */
export function trimAt(sketch: Sketch, p: Point2, tol: number): TrimHit | null {
  const o = outlines(sketch);
  let best: (TrimHit & { d: number }) | null = null;
  for (const e of sketch.entities) {
    if (!trimmable(e)) continue;
    for (let k = 0; k + 1 < e.points.length; k++) {
      const [a, b] = [e.points[k]!, e.points[k + 1]!];
      const { d, t } = pointSegDist(p, a, b);
      if (d > tol || (best && d >= best.d)) continue;
      const ts = crossings(a, b, { owner: e.id, k }, o);
      const t1 = [0, ...ts].filter((x) => x <= t).at(-1)!;
      const t2 = [...ts, 1].find((x) => x >= t)!;
      best = { entity: e.id, k, t1, t2, piece: [lerp(a, b, t1), lerp(a, b, t2)], d };
    }
  }
  if (!best) return null;
  const { d: _d, ...hit } = best;
  void _d;
  return hit;
}

/** 잘라내기 명령: 원래 선을 지우고 남은 조각(들)을 다시 추가 */
export function trimCommands(sketch: Sketch, hit: TrimHit): CadCommand[] {
  const e = sketch.entities.find((x) => x.id === hit.entity);
  if (!e || !trimmable(e)) return [];
  const pts = e.points as Point2[];
  const P1 = rp(lerp(pts[hit.k]!, pts[hit.k + 1]!, hit.t1));
  const P2 = rp(lerp(pts[hit.k]!, pts[hit.k + 1]!, hit.t2));
  const before = [...pts.slice(0, hit.k + 1), ...(hit.t1 > 1e-6 ? [P1] : [])];
  const after = [...(hit.t2 < 1 - 1e-6 ? [P2] : []), ...pts.slice(hit.k + 1)];
  const taken = new Set(sketch.entities.map((x) => x.id));
  const id = (prefix: string) => {
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n++;
    taken.add(`${prefix}${n}`);
    return `${prefix}${n}`;
  };
  const out: CadCommand[] = [{ type: 'delete_sketch_entity', sketch: sketch.id, entity: e.id }];
  for (const piece of [before, after]) {
    if (piece.length < 2) continue;
    if (piece.length === 2 && Math.hypot(piece[1]![0] - piece[0]![0], piece[1]![1] - piece[0]![1]) < 1e-6) continue;
    if (e.type === 'line' || piece.length === 2) out.push({ type: e.type === 'line' ? 'add_line' : 'add_path', sketch: sketch.id, id: id(e.type === 'line' ? 'line' : 'path'), points: piece.length === 2 ? [piece[0]!, piece[1]!] : piece } as CadCommand);
    else out.push({ type: 'add_path', sketch: sketch.id, id: id('path'), points: piece });
  }
  return out;
}

/** 연장: 커서 p 근처(tol)의 선 끝점 → 그 방향으로 가장 가까운 다른 요소까지. 없으면 null */
export function extendAt(sketch: Sketch, p: Point2, tol: number): { point: string; from: Point2; to: Point2 } | null {
  const o = outlines(sketch);
  let best: { point: string; from: Point2; to: Point2; d: number } | null = null;
  for (const e of sketch.entities) {
    if (!trimmable(e)) continue;
    const n = e.points.length;
    for (const end of [0, n - 1]) {
      const P = e.points[end]!;
      const Q = e.points[end === 0 ? 1 : n - 2]!; // 끝 변의 다른 끝
      const d = Math.hypot(p[0] - P[0], p[1] - P[1]);
      if (d > tol * 3 || (best && d >= best.d)) continue;
      // 반직선 Q→P 를 P 너머로: 끝 변 매개변수 t>1 의 첫 교차
      const k = end === 0 ? 0 : n - 2;
      const ts = crossings(Q, P, { owner: e.id, k }, o, true).filter((t) => t > 1 + 1e-6);
      if (!ts.length) continue;
      best = { point: `${e.id}.p${end}`, from: P, to: rp(lerp(Q, P, ts[0]!)), d };
    }
  }
  if (!best) return null;
  return { point: best.point, from: best.from, to: best.to };
}
