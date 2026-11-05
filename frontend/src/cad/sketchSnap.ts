/**
 * 스케치 그리기 스냅 (솔리드웍스 "추정선"처럼) — 순수 함수.
 * 우선순위: 1) 점 스냅(끝점·중심·중간점·사분점·원점) 2) 수평·수직 정렬(다른 점과 같은 u 또는 v) 3) 격자 4) 그대로.
 * Shift 로 그리는 선은 기준점에서 각도 스냅(15°).
 */
import type { Point2, Sketch } from './commandTypes';
import { dimensionValue } from './sketch';

export type SnapPointKind = 'endpoint' | 'center' | 'midpoint' | 'quadrant' | 'origin';
export interface SnapPoint {
  p: Point2;
  kind: SnapPointKind;
}
export interface SnapGuide {
  /** h = 수평선(같은 v), v = 수직선(같은 u), angle = 기준점에서 각도 */
  dir: 'h' | 'v' | 'angle';
  from: Point2;
}
export interface SnapResult {
  point: Point2;
  kind: SnapPointKind | 'grid' | 'free';
  guides: SnapGuide[];
  /** 각도 스냅일 때 각도(°) */
  angle?: number;
}

export interface SnapOptions {
  /** 이 거리(mm) 안이면 붙는다 — 화면 픽셀을 mm 로 바꾼 값 */
  tol: number;
  /** 격자 간격 (null = 격자 스냅 끔) */
  grid: number | null;
  /** 점·정렬 스냅 */
  inference: boolean;
  /** 각도 스냅 기준점 (Shift 를 누르고 선을 그릴 때) */
  angleFrom?: Point2 | null;
  angleStep?: number;
}

export const SNAP_LABEL: Record<SnapResult['kind'], string> = {
  endpoint: '끝점',
  center: '중심',
  midpoint: '중간점',
  quadrant: '사분점',
  origin: '원점',
  grid: '',
  free: '',
};

const rot = ([x, y]: Point2, deg: number): Point2 => {
  const a = (deg * Math.PI) / 180;
  return [x * Math.cos(a) - y * Math.sin(a), x * Math.sin(a) + y * Math.cos(a)];
};
const add = (a: Point2, b: Point2): Point2 => [a[0] + b[0], a[1] + b[1]];
const mid = (a: Point2, b: Point2): Point2 => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];

/** 스케치 요소의 스냅 점 + 그리는 중인 점들 + 원점 */
export function sketchSnapPoints(sketch: Sketch | null, drawing: Point2[] = []): SnapPoint[] {
  const out: SnapPoint[] = [{ p: [0, 0], kind: 'origin' }];
  for (const e of sketch?.entities ?? []) {
    const dim = (k: 'width' | 'height' | 'diameter' | 'length') => (sketch ? dimensionValue(sketch, e.id, k) : undefined) ?? 0;
    if (e.type === 'rectangle') {
      const [w, h] = [dim('width') / 2, dim('height') / 2];
      const c = e.center;
      out.push({ p: c, kind: 'center' });
      const corners: Point2[] = [[-w, -h], [w, -h], [w, h], [-w, h]].map((d) => add(c, d as Point2));
      corners.forEach((p, i) => {
        out.push({ p, kind: 'endpoint' });
        out.push({ p: mid(p, corners[(i + 1) % 4]!), kind: 'midpoint' });
      });
    } else if (e.type === 'circle') {
      const r = dim('diameter') / 2;
      out.push({ p: e.center, kind: 'center' });
      for (const d of [[r, 0], [0, r], [-r, 0], [0, -r]] as Point2[]) out.push({ p: add(e.center, d), kind: 'quadrant' });
    } else if (e.type === 'ellipse') {
      out.push({ p: e.center, kind: 'center' });
      const [a, b] = [dim('width') / 2, dim('height') / 2];
      for (const d of [[a, 0], [0, b], [-a, 0], [0, -b]] as Point2[]) out.push({ p: add(e.center, rot(d, e.angle)), kind: 'quadrant' });
    } else if (e.type === 'slot') {
      out.push({ p: e.center, kind: 'center' });
      const l = dim('length') / 2;
      for (const d of [[l, 0], [-l, 0]] as Point2[]) out.push({ p: add(e.center, rot(d, e.angle)), kind: 'center' });
    } else if (e.type === 'polygon' || e.type === 'path' || e.type === 'line') {
      const pts = e.points;
      const closed = e.type === 'polygon';
      pts.forEach((p, i) => {
        out.push({ p, kind: 'endpoint' });
        const q = pts[i + 1] ?? (closed ? pts[0] : undefined);
        const straight = e.type === 'line' || (!e.arcs?.[i] && !e.spline);
        if (q && straight) out.push({ p: mid(p, q), kind: 'midpoint' });
      });
    }
  }
  for (const p of drawing) out.push({ p, kind: 'endpoint' });
  return out;
}

const roundStep = (v: number, s: number) => Number((Math.round(v / s) * s).toFixed(6)) + 0;
const ORDER: SnapPointKind[] = ['endpoint', 'center', 'origin', 'midpoint', 'quadrant'];

export function snapSketchPoint(raw: Point2, points: SnapPoint[], o: SnapOptions): SnapResult {
  // 1) 각도 스냅 (Shift): 기준점에서 가장 가까운 각도 방향, 길이는 격자로
  if (o.angleFrom) {
    const [dx, dy] = [raw[0] - o.angleFrom[0], raw[1] - o.angleFrom[1]];
    const step = o.angleStep ?? 15;
    const ang = Math.round(((Math.atan2(dy, dx) * 180) / Math.PI) / step) * step;
    const len = o.grid ? roundStep(Math.hypot(dx, dy), o.grid) : Math.hypot(dx, dy);
    const a = (ang * Math.PI) / 180;
    const p: Point2 = [o.angleFrom[0] + len * Math.cos(a), o.angleFrom[1] + len * Math.sin(a)].map((v) => Number(v.toFixed(6)) + 0) as Point2;
    return { point: p, kind: 'grid', guides: [{ dir: 'angle', from: o.angleFrom }], angle: ((ang % 360) + 360) % 360 };
  }
  if (o.inference) {
    // 2) 점 스냅: 가까운 점, 거리가 비슷하면 끝점 > 중심 > 원점 > 중간점 > 사분점
    let best: SnapPoint | null = null;
    let bestD = Infinity;
    for (const s of points) {
      const d = Math.hypot(s.p[0] - raw[0], s.p[1] - raw[1]);
      if (d > o.tol) continue;
      const better = d < bestD - o.tol * 0.25 || (Math.abs(d - bestD) <= o.tol * 0.25 && best && ORDER.indexOf(s.kind) < ORDER.indexOf(best.kind));
      if (!best || better) {
        best = s;
        bestD = d;
      }
    }
    if (best) return { point: [...best.p], kind: best.kind, guides: [] };
  }
  // 3) 격자
  let point: Point2 = o.grid ? [roundStep(raw[0], o.grid), roundStep(raw[1], o.grid)] : [...raw];
  let kind: SnapResult['kind'] = o.grid ? 'grid' : 'free';
  const guides: SnapGuide[] = [];
  if (o.inference) {
    // 4) 정렬: 다른 점과 u(수직선) 또는 v(수평선)가 거의 같으면 맞춘다 — 가장 가까운 점 하나씩
    let vx: SnapPoint | null = null;
    let hy: SnapPoint | null = null;
    for (const s of points) {
      if (Math.abs(s.p[0] - raw[0]) <= o.tol && (!vx || Math.abs(s.p[0] - raw[0]) < Math.abs(vx.p[0] - raw[0]))) vx = s;
      if (Math.abs(s.p[1] - raw[1]) <= o.tol && (!hy || Math.abs(s.p[1] - raw[1]) < Math.abs(hy.p[1] - raw[1]))) hy = s;
    }
    if (vx) {
      point = [vx.p[0], point[1]];
      guides.push({ dir: 'v', from: vx.p });
    }
    if (hy) {
      point = [point[0], hy.p[1]];
      guides.push({ dir: 'h', from: hy.p });
    }
    if (guides.length) kind = 'free';
  }
  return { point, kind, guides };
}

/**
 * 화면 확대에 맞춘 격자 간격: 잔 칸이 minPx 픽셀 이상이 되는 1·2·5 계열 간격, 굵은 선은 10 단위(2 계열은 5칸).
 */
export function autoGridStep(mmPerPx: number, minPx = 7): { minor: number; major: number } {
  const steps = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000];
  const minor = steps.find((s) => s / mmPerPx >= minPx) ?? 5000;
  const lead = Number(minor.toExponential().slice(0, 1));
  return { minor, major: minor * (lead === 2 ? 5 : 10) };
}
