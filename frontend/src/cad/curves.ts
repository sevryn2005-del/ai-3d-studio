/**
 * 형식 v10 곡선 규칙 (모든 엔진이 같은 점을 쓴다 — 서버 backend/app/cad/curves.py 가 같은 계산):
 *
 * - 꼭짓점 처리(corners): 다각형·경로의 꼭짓점 k 를 필렛(반지름 size 의 접하는 호) 또는 모따기(양쪽으로 size 만큼 자른 직선)로.
 *   경로는 양 끝점을 제외한 안쪽 꼭짓점만. 정밀 엔진은 호를 정확한 원호로, 메시 엔진은 허용 오차로 나눈 점으로 쓴다.
 * - 경로(path): 열린 꺾은선. 스윕·리브(얇은 돌출)의 중심선.
 * - 얇은 단면(thinPolygon): 열린 선을 양쪽으로 두께/2 씩 띄운 닫힌 다각형 (꺾인 곳은 모서리를 연장해 만남).
 * - 스윕 고리(sweepRings): 단면(바운딩 박스 중심 기준 u·v)을 경로 시작점에 경로 방향과 수직으로 세우고, 꺾인 곳은 이등분면(마이터)으로 잇는다.
 *   경로는 스케치 평면 위에 있으므로 단면의 v 축 = 경로 평면의 법선(고정), u 축 = 그 평면 안에서 경로에 수직.
 */
import type { Point2 } from './commandTypes';

export type CornerType = 'fillet' | 'chamfer';
export interface Corner {
  k: number;
  type: CornerType;
  size: number;
}

export type Segment =
  | { type: 'line'; a: Point2; b: Point2 }
  | { type: 'arc'; a: Point2; b: Point2; c: Point2; r: number; ccw: boolean; sweep: number; mid: Point2 };

/** 윤곽 표본(로프트·헬릭스·스윕 단면, 리브 중심선): 호를 π/32 이하 각도로 나눈다 (두 엔진 공통) */
export const OUTLINE_STEP = Math.PI / 32;

const sub = (a: Point2, b: Point2): Point2 => [a[0] - b[0], a[1] - b[1]];
const len = (a: Point2) => Math.hypot(a[0], a[1]);
const unit = (a: Point2): Point2 => {
  const l = len(a);
  return [a[0] / l, a[1] / l];
};
const at = (p: Point2, d: Point2, s: number): Point2 => [p[0] + d[0] * s, p[1] + d[1] * s];

interface CornerCut {
  /** 들어오는 변 쪽 자른 점, 나가는 변 쪽 자른 점, 꼭짓점에서 잘린 길이 */
  a: Point2;
  b: Point2;
  cut: number;
  seg: Segment | null;
}

function cutCorner(prev: Point2, v: Point2, next: Point2, corner: Corner | undefined): CornerCut {
  const plain = { a: v, b: v, cut: 0, seg: null };
  if (!corner || corner.size <= 0) return plain;
  const d1 = unit(sub(prev, v));
  const d2 = unit(sub(next, v));
  const cos = Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1]));
  const theta = Math.acos(cos); // 꼭짓점의 사이각
  if (theta > Math.PI - 1e-9 || theta < 1e-9) return plain; // 일직선(또는 되돌아감)
  if (corner.type === 'chamfer') {
    const a = at(v, d1, corner.size);
    const b = at(v, d2, corner.size);
    return { a, b, cut: corner.size, seg: { type: 'line', a, b } };
  }
  const r = corner.size;
  const t = r / Math.tan(theta / 2);
  const a = at(v, d1, t);
  const b = at(v, d2, t);
  const bis = unit([d1[0] + d2[0], d1[1] + d2[1]]);
  const c = at(v, bis, r / Math.sin(theta / 2));
  const ca = sub(a, c);
  const cb = sub(b, c);
  const ccw = ca[0] * cb[1] - ca[1] * cb[0] > 0;
  const mid = at(c, unit(sub(v, c)), r);
  return { a, b, cut: t, seg: { type: 'arc', a, b, c, r, ccw, sweep: Math.PI - theta, mid } };
}

/** 꼭짓점 처리를 적용한 윤곽 조각 (닫힘: 마지막 조각이 처음으로 돌아온다) */
export function cornerSegments(points: Point2[], corners: Corner[] | undefined, closed: boolean): Segment[] {
  const n = points.length;
  const byK = new Map((corners ?? []).map((c) => [c.k, c]));
  const cuts = points.map((v, k) => {
    if (!closed && (k === 0 || k === n - 1)) return { a: v, b: v, cut: 0, seg: null } as CornerCut;
    return cutCorner(points[(k - 1 + n) % n]!, v, points[(k + 1) % n]!, byK.get(k));
  });
  const segs: Segment[] = [];
  const last = closed ? n : n - 1;
  for (let k = 0; k < last; k++) {
    const from = cuts[k]!;
    const to = cuts[(k + 1) % n]!;
    if (len(sub(to.a, from.b)) > 1e-12) segs.push({ type: 'line', a: from.b, b: to.a });
    if (to.seg && (closed || k + 1 < n - 1)) segs.push(to.seg);
  }
  return segs;
}

/** 꼭짓점 처리가 들어가지 않으면 사용자용 메시지 (변 하나에 양 끝 처리 길이의 합이 변 길이를 넘음) */
export function cornerError(points: Point2[], corners: Corner[] | undefined, closed: boolean): string | null {
  if (!corners?.length) return null;
  const n = points.length;
  const seen = new Set<number>();
  for (const c of corners) {
    if (c.k >= n || (!closed && (c.k === 0 || c.k === n - 1))) return `꼭짓점 p${c.k} 에는 모서리 처리를 할 수 없습니다${closed ? '' : ' (경로의 양 끝점)'}`;
    if (seen.has(c.k)) return `꼭짓점 p${c.k} 의 모서리 처리가 중복되었습니다`;
    seen.add(c.k);
  }
  const byK = new Map(corners.map((c) => [c.k, c]));
  const cut = points.map((v, k) =>
    !closed && (k === 0 || k === n - 1) ? 0 : cutCorner(points[(k - 1 + n) % n]!, v, points[(k + 1) % n]!, byK.get(k)).cut,
  );
  for (let k = 0; k < (closed ? n : n - 1); k++) {
    const edge = len(sub(points[(k + 1) % n]!, points[k]!));
    if (cut[k]! + cut[(k + 1) % n]! > edge + 1e-9) return `모서리 처리(p${k}·p${(k + 1) % n})가 변 길이 ${Math.round(edge * 1000) / 1000}mm 보다 큽니다. 크기를 줄이세요`;
  }
  return null;
}

/** 호를 나누는 수: 각도 간격 step 이하 (최소 2) */
export function arcDivisions(sweep: number, step: number): number {
  return Math.max(2, Math.ceil(sweep / step - 1e-9));
}

/** 허용 오차(현의 오차)로 정한 각도 간격 — 메시 엔진용 */
export function toleranceStep(r: number, tol: number): number {
  return r <= tol ? Math.PI / 8 : Math.min(Math.PI / 8, 2 * Math.acos(1 - tol / r));
}

/** 조각 → 점 (닫힘: 마지막 점이 처음과 같지 않게, 열림: 양 끝 포함) */
export function sampleSegments(segs: Segment[], closed: boolean, step: (r: number) => number = () => OUTLINE_STEP): Point2[] {
  const out: Point2[] = [];
  for (const s of segs) {
    out.push(s.a);
    if (s.type === 'arc') {
      const n = arcDivisions(s.sweep, step(s.r));
      const a0 = Math.atan2(s.a[1] - s.c[1], s.a[0] - s.c[0]);
      const dir = s.ccw ? 1 : -1;
      for (let i = 1; i < n; i++) {
        const t = a0 + (dir * s.sweep * i) / n;
        out.push([s.c[0] + s.r * Math.cos(t), s.c[1] + s.r * Math.sin(t)]);
      }
    }
  }
  if (!closed && segs.length) out.push(segs[segs.length - 1]!.b);
  return out;
}

/** 꼭짓점 처리를 적용한 점 목록 (윤곽 표본) */
export function roundedPoints(points: Point2[], corners: Corner[] | undefined, closed: boolean, step?: (r: number) => number): Point2[] {
  if (!corners?.length) return points.map((p) => [p[0], p[1]]);
  return sampleSegments(cornerSegments(points, corners, closed), closed, step);
}

/** 열린 선을 두께 t 로 띄운 닫힌 다각형 (꺾인 곳 = 모서리 연장) */
export function thinPolygon(pts: Point2[], t: number): Point2[] {
  const h = t / 2;
  const normals = pts.slice(1).map((q, i) => {
    const d = unit(sub(q, pts[i]!));
    return [-d[1], d[0]] as Point2;
  });
  const side = (s: number) =>
    pts.map((p, i) => {
      if (i === 0) return at(p, normals[0]!, s * h);
      if (i === pts.length - 1) return at(p, normals[normals.length - 1]!, s * h);
      const n1 = normals[i - 1]!;
      const n2 = normals[i]!;
      const m = unit([n1[0] + n2[0], n1[1] + n2[1]]);
      return at(p, m, (s * h) / (m[0] * n2[0] + m[1] * n2[1]));
    });
  return [...side(1), ...side(-1).reverse()];
}

/** 열린 선 점들이 쓸 만한지 (중복 점, 되돌아가는 꺾임) */
export function openPathError(pts: Point2[]): string | null {
  for (let i = 1; i < pts.length; i++) if (len(sub(pts[i]!, pts[i - 1]!)) < 1e-6) return `p${i - 1}·p${i} 가 같은 점입니다`;
  for (let i = 1; i + 1 < pts.length; i++) {
    const d1 = unit(sub(pts[i]!, pts[i - 1]!));
    const d2 = unit(sub(pts[i + 1]!, pts[i]!));
    if (d1[0] * d2[0] + d1[1] * d2[1] < -1 + 1e-6) return `p${i} 에서 경로가 되돌아갑니다`;
  }
  return null;
}

type V3 = [number, number, number];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot3 = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const norm3 = (a: V3): V3 => {
  const l = Math.hypot(...a);
  return [a[0] / l, a[1] / l, a[2] / l];
};

/**
 * 스윕 고리. profile = 단면 점(바운딩 박스 중심 기준 u·v, 반시계), path = 경로 점(객체 로컬), B = 경로 평면 법선(로컬, 단위).
 * 반환: 고리마다 단면 점 수만큼의 3D 점. 꺾인 곳은 마이터(이등분면) 고리.
 */
export function sweepRings(profile: Point2[], path: V3[], B: V3): V3[][] {
  const T = path.slice(1).map((q, i) => norm3([q[0] - path[i]![0], q[1] - path[i]![1], q[2] - path[i]![2]]));
  const N = T.map((t) => cross(B, t));
  return path.map((p, i) => {
    let m: V3;
    let s = 1;
    if (i === 0) m = N[0]!;
    else if (i === path.length - 1) m = N[N.length - 1]!;
    else {
      m = norm3([N[i - 1]![0] + N[i]![0], N[i - 1]![1] + N[i]![1], N[i - 1]![2] + N[i]![2]]);
      s = 1 / dot3(m, N[i]!);
    }
    return profile.map(([u, v]) => [p[0] + m[0] * u * s + B[0] * v, p[1] + m[1] * u * s + B[1] * v, p[2] + m[2] * u * s + B[2] * v] as V3);
  });
}

/** 스윕 고리가 서로 겹치지 않는지: 꺾인 곳마다 단면 반폭 × tan(꺾임/2) 만큼 양쪽 변을 쓴다 */
export function sweepError(profile: Point2[], path: Point2[]): string | null {
  if (path.length < 2) return '경로에 점이 2개 이상 있어야 합니다';
  const e = Math.max(...profile.map((q) => Math.abs(q[0])));
  const use = path.map((p, i) => {
    if (i === 0 || i === path.length - 1) return 0;
    const d1 = unit(sub(p, path[i - 1]!));
    const d2 = unit(sub(path[i + 1]!, p));
    const turn = Math.acos(Math.max(-1, Math.min(1, d1[0] * d2[0] + d1[1] * d2[1])));
    return e * Math.tan(turn / 2);
  });
  for (let i = 0; i + 1 < path.length; i++) {
    const l = len(sub(path[i + 1]!, path[i]!));
    if (use[i]! + use[i + 1]! > l + 1e-6)
      return `경로가 단면에 비해 너무 급하게 꺾입니다 (꺾이는 곳의 둥글기 반지름을 단면 반폭 ${Math.round(e * 1000) / 1000}mm 보다 크게 하세요)`;
  }
  return null;
}
