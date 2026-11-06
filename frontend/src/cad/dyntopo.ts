/**
 * 다이나믹 토폴로지 (블렌더 Dyntopo, 스컬프트): 붓이 지나가는 곳만 점을 늘린다 — 순수 함수.
 * 붓 구(반경)에 닿는 면을 삼각형으로 나누고, 붓 구를 지나는 선 중 maxEdge 보다 긴 것을 긴 것부터 반으로 쪼갠다.
 * 선을 쪼개면 그 선을 쓰는 양쪽 면이 같이 나뉘므로 닫힌 메시는 닫힌 채로 남는다 (반경 밖 다각형 면은 점 하나가 끼어든 n각형).
 * 새 점의 부모(양 끝점)를 함께 돌려줘 마스크 같은 점별 값을 이어 붙일 수 있다.
 */
import type { PolyMesh, V3 } from './polymesh';

export interface RefineResult {
  mesh: PolyMesh;
  /** 새 점마다 [끝점 a, 끝점 b] (새 점 번호 = 원래 점 수 + i) */
  parents: [number, number][];
}

const d2 = (a: V3, b: V3) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
/** 점 c 에서 선분 a–b 까지 거리² */
function segD2(c: V3, a: V3, b: V3): number {
  const ab: V3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const L = ab[0] ** 2 + ab[1] ** 2 + ab[2] ** 2;
  const t = L > 0 ? Math.max(0, Math.min(1, ((c[0] - a[0]) * ab[0] + (c[1] - a[1]) * ab[1] + (c[2] - a[2]) * ab[2]) / L)) : 0;
  return d2(c, [a[0] + ab[0] * t, a[1] + ab[1] * t, a[2] + ab[2] * t]);
}
/** 점 c 에서 면 점들의 축 정렬 상자까지 거리² (면이 붓 구에 닿을 수 있는지 빠르게) */
function boxD2(c: V3, f: number[], verts: V3[]): number {
  let s = 0;
  for (let a = 0; a < 3; a++) {
    let lo = Infinity;
    let hi = -Infinity;
    for (const v of f) {
      lo = Math.min(lo, verts[v]![a]!);
      hi = Math.max(hi, verts[v]![a]!);
    }
    const d = c[a]! < lo ? lo - c[a]! : c[a]! > hi ? c[a]! - hi : 0;
    s += d * d;
  }
  return s;
}

/**
 * @param maxEdge 이보다 긴 선을 쪼갠다 (mm)
 * @param passes 쪼개기 반복 횟수 (한 번 찍기에 너무 많이 늘지 않게)
 */
export function refineNear(m: PolyMesh, center: V3, radius: number, maxEdge: number, maxVerts = 50_000, passes = 3): RefineResult | null {
  if (!(maxEdge > 0) || !(radius > 0)) return null;
  const verts: V3[] = [...m.verts];
  const r2 = radius * radius;
  // 1. 가까운 면을 삼각형으로 (부채꼴, 방향 유지)
  let faces: number[][] = [];
  let changed = false;
  for (const f of m.faces) {
    if (f.length > 3 && boxD2(center, f, verts) <= r2) {
      for (let k = 1; k + 1 < f.length; k++) faces.push([f[0]!, f[k]!, f[k + 1]!]);
      changed = true;
    } else faces.push(f);
  }
  const parents: [number, number][] = [];
  const max2 = maxEdge * maxEdge;
  for (let pass = 0; pass < passes; pass++) {
    // 2. 붓 구를 지나는 긴 선 모으기 + 선 → 면
    const edgeFaces = new Map<string, number[]>();
    const cand: { a: number; b: number; len: number }[] = [];
    faces.forEach((f, fi) => {
      for (let k = 0; k < f.length; k++) {
        const a = f[k]!;
        const b = f[(k + 1) % f.length]!;
        const key = a < b ? `${a},${b}` : `${b},${a}`;
        const list = edgeFaces.get(key);
        if (list) {
          list.push(fi);
          continue;
        }
        edgeFaces.set(key, [fi]);
        const A = verts[a]!;
        const B = verts[b]!;
        const len = d2(A, B);
        if (len <= max2) continue;
        if (segD2(center, A, B) <= r2) cand.push({ a: Math.min(a, b), b: Math.max(a, b), len });
      }
    });
    if (!cand.length) break;
    cand.sort((x, y) => y.len - x.len);
    const touched = new Set<number>();
    let split = 0;
    for (const { a, b } of cand) {
      if (verts.length >= maxVerts) break;
      const fs = edgeFaces.get(`${a},${b}`)!;
      // 이번 회차에 이미 나뉜 면이 끼어 있으면 다음 회차로 (선-면 표가 낡았으므로)
      if (fs.some((fi) => touched.has(fi))) continue;
      const A = verts[a]!;
      const B = verts[b]!;
      const mi = verts.length;
      verts.push([(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2]);
      parents.push([a, b]);
      for (const fi of fs) {
        const f = faces[fi]!;
        const k = f.findIndex((x, i) => (x === a && f[(i + 1) % f.length] === b) || (x === b && f[(i + 1) % f.length] === a));
        if (k < 0) continue;
        const p = f[k]!;
        const q = f[(k + 1) % f.length]!;
        if (f.length === 3) {
          const c = f[(k + 2) % 3]!;
          faces[fi] = [p, mi, c];
          touched.add(fi);
          touched.add(faces.length);
          faces.push([mi, q, c]);
        } else {
          // 반경 밖 다각형: 점만 끼워 넣는다
          faces[fi] = [...f.slice(0, k + 1), mi, ...f.slice(k + 1)];
          touched.add(fi);
        }
      }
      split++;
    }
    if (!split) break;
    changed = true;
  }
  if (!changed) return null;
  faces = faces.filter((f) => f.length >= 3);
  return { mesh: { verts, faces }, parents };
}

/** 부모 평균으로 점별 값 늘리기 (마스크 등). values 길이 = 원래 점 수 */
export function extendValues(values: ArrayLike<number>, parents: [number, number][]): number[] {
  const out = Array.from(values);
  for (const [a, b] of parents) out.push(((out[a] ?? 0) + (out[b] ?? 0)) / 2);
  return out;
}
