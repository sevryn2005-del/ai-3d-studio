/**
 * 숨은선 정리 (서버 app/cad/drawing.py clean_hidden 과 같은 규칙):
 * 숨은선 조각 중 보이는 선이나 앞서 남긴 숨은선과 같은 직선 위에서 겹치는 부분을 지운다 (도면 규칙: 보이는 선이 우선, 같은 선은 한 번).
 */
export const CLEAN_TOLERANCE = 1e-3;

type Seg = [number, number, number, number];

function segments(lines: number[][]): Seg[] {
  const out: Seg[] = [];
  for (const l of lines) for (let i = 2; i + 1 < l.length; i += 2) out.push([l[i - 2]!, l[i - 1]!, l[i]!, l[i + 1]!]);
  return out;
}

/** 조각 (p → q) 중 cover 와 겹치지 않는 구간 [t0, t1] (0~길이) */
function uncovered(s: Seg, cover: Seg[], tol: number): [number, number][] {
  const [px, py, qx, qy] = s;
  const L = Math.hypot(qx - px, qy - py);
  if (L < tol) return [];
  const dx = (qx - px) / L;
  const dy = (qy - py) / L;
  const iv: [number, number][] = [];
  for (const [ax, ay, bx, by] of cover) {
    if (Math.max(ax, bx) < Math.min(px, qx) - tol || Math.min(ax, bx) > Math.max(px, qx) + tol) continue;
    if (Math.max(ay, by) < Math.min(py, qy) - tol || Math.min(ay, by) > Math.max(py, qy) + tol) continue;
    const da = Math.abs((ax - px) * dy - (ay - py) * dx);
    const db = Math.abs((bx - px) * dy - (by - py) * dx);
    if (da > tol || db > tol) continue;
    const ta = (ax - px) * dx + (ay - py) * dy;
    const tb = (bx - px) * dx + (by - py) * dy;
    const lo = Math.max(0, Math.min(ta, tb));
    const hi = Math.min(L, Math.max(ta, tb));
    if (hi - lo > tol) iv.push([lo, hi]);
  }
  iv.sort((a, b) => a[0] - b[0]);
  const out: [number, number][] = [];
  let at = 0;
  for (const [lo, hi] of iv) {
    if (lo - at > tol) out.push([at, lo]);
    at = Math.max(at, hi);
  }
  if (L - at > tol) out.push([at, L]);
  return out;
}

export function cleanHidden(visible: number[][], hidden: number[][], tol = CLEAN_TOLERANCE): number[][] {
  const cover = segments(visible);
  const out: number[][] = [];
  for (const line of hidden) {
    const start = out.length;
    let cur: number[] | null = null;
    for (let i = 2; i + 1 < line.length; i += 2) {
      const s: Seg = [line[i - 2]!, line[i - 1]!, line[i]!, line[i + 1]!];
      const L = Math.hypot(s[2] - s[0], s[3] - s[1]);
      const keep = uncovered(s, cover, tol);
      for (const [t0, t1] of keep) {
        const ax = s[0] + ((s[2] - s[0]) * t0) / L;
        const ay = s[1] + ((s[3] - s[1]) * t0) / L;
        const bx = s[0] + ((s[2] - s[0]) * t1) / L;
        const by = s[1] + ((s[3] - s[1]) * t1) / L;
        if (cur && Math.hypot(cur[cur.length - 2]! - ax, cur[cur.length - 1]! - ay) < tol) cur.push(bx, by);
        else {
          if (cur) out.push(cur);
          cur = [ax, ay, bx, by];
        }
      }
      // 이 조각 끝까지 남지 않았으면 선이 끊긴다
      if (!keep.length || keep[keep.length - 1]![1] < L - tol) {
        if (cur) out.push(cur);
        cur = null;
      }
    }
    if (cur) out.push(cur);
    // 남긴 숨은선은 다음 숨은선의 덮개 (같은 숨은선이 두 번 나오지 않게)
    cover.push(...segments(out.slice(start)));
  }
  return out.map((l) => l.map((v) => Math.round(v * 1e6) / 1e6 + 0));
}
