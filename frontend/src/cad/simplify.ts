/** 꺾은선 단순화 (Douglas–Peucker) — 글꼴·SVG·DXF 의 촘촘한 곡선을 스케치 점 한도 안으로 */
import type { Point2 } from './commandTypes';

/** 꺾은선 단순화 (Douglas–Peucker, 닫힌 고리): 첫 점과 가장 먼 점에서 둘로 나눠 각각 */
export function simplifyClosed(pts: Point2[], tol: number): Point2[] {
  if (pts.length <= 3) return pts;
  let far = 0;
  let farD = -1;
  pts.forEach((p, k) => {
    const d = Math.hypot(p[0] - pts[0]![0], p[1] - pts[0]![1]);
    if (d > farD) [far, farD] = [k, d];
  });
  const ka = simplifyOpen(pts.slice(0, far + 1), tol);
  const kb = simplifyOpen([...pts.slice(far), pts[0]!], tol);
  return pts.filter((_, k) => (k <= far ? ka[k] : kb[k - far]));
}

/** 열린 꺾은선 DP: 남길 점 표시 */
function simplifyOpen(pts: Point2[], tol: number): boolean[] {
  const keep = new Array<boolean>(pts.length).fill(false);
  keep[0] = keep[pts.length - 1] = true;
  const rec = (i: number, j: number) => {
    const [ax, ay] = pts[i]!;
    const [bx, by] = pts[j]!;
    const len = Math.hypot(bx - ax, by - ay) || 1e-12;
    let best = -1;
    let bestD = tol;
    for (let k = i + 1; k < j; k++) {
      const d = Math.abs((bx - ax) * (ay - pts[k]![1]) - (ax - pts[k]![0]) * (by - ay)) / len;
      if (d > bestD) {
        bestD = d;
        best = k;
      }
    }
    if (best < 0) return;
    keep[best] = true;
    rec(i, best);
    rec(best, j);
  };
  rec(0, pts.length - 1);
  return keep;
}

/** 닫힌 고리를 점 max 개 이하가 될 때까지 허용 오차를 늘려가며 단순화 */
export function simplifyToLimit(pts: Point2[], max: number, tol0: number): Point2[] {
  let tol = tol0;
  let s = simplifyClosed(pts, tol);
  while (s.length > max) s = simplifyClosed(pts, (tol *= 1.5));
  return s;
}
