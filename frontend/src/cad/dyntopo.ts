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

export interface CollapseResult {
  mesh: PolyMesh;
  /** 원래 점 번호 → 새 번호 (−1 = 없어짐: 다른 점과 합쳐짐 — 합쳐진 점 번호는 remap 의 그 점과 같다) */
  remap: Int32Array;
}

const sub3 = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross3 = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const triNormal = (p: V3, q: V3, r: V3) => cross3(sub3(q, p), sub3(r, p));

/**
 * 짧은 선 합치기 (블렌더 Dyntopo collapse): 붓 구를 지나는 선 중 minEdge 보다 짧은 것을 가운데 점 하나로 합친다.
 * 삼각형 둘 사이의 선만, 두 점의 공통 이웃이 정확히 그 두 삼각형의 맞은편 점일 때만 (링크 조건 — 겹친 면·구멍이 생기지 않음),
 * 합친 뒤 둘레 면이 뒤집히면 하지 않는다. 쓰이지 않는 점은 지우고 번호를 당긴다 (remap).
 */
export function collapseNear(m: PolyMesh, center: V3, radius: number, minEdge: number, passes = 2): CollapseResult | null {
  if (!(minEdge > 0) || !(radius > 0)) return null;
  const verts: V3[] = m.verts.map((v) => [...v] as V3);
  let faces: (number[] | null)[] = m.faces.map((f) => [...f]);
  const alias = new Int32Array(verts.length).map((_, i) => i); // 합쳐진 점 → 남은 점
  const r2 = radius * radius;
  const min2 = minEdge * minEdge;
  let changed = false;
  for (let pass = 0; pass < passes; pass++) {
    const vf: number[][] = verts.map(() => []);
    faces.forEach((f, fi) => f?.forEach((v) => vf[v]!.push(fi)));
    const nbr = (v: number) => {
      const s = new Set<number>();
      for (const fi of vf[v]!) {
        const f = faces[fi]!;
        const k = f.indexOf(v);
        s.add(f[(k + 1) % f.length]!);
        s.add(f[(k - 1 + f.length) % f.length]!);
      }
      return s;
    };
    const cand: { a: number; b: number; len: number }[] = [];
    const seen = new Set<string>();
    faces.forEach((f) => {
      if (!f || f.length !== 3) return;
      for (let k = 0; k < 3; k++) {
        const a = Math.min(f[k]!, f[(k + 1) % 3]!);
        const b = Math.max(f[k]!, f[(k + 1) % 3]!);
        const key = `${a},${b}`;
        if (seen.has(key)) continue;
        seen.add(key);
        const len = d2(verts[a]!, verts[b]!);
        if (len < min2 && segD2(center, verts[a]!, verts[b]!) <= r2) cand.push({ a, b, len });
      }
    });
    if (!cand.length) break;
    cand.sort((x, y) => x.len - y.len);
    const locked = new Set<number>();
    let done = 0;
    for (const { a, b } of cand) {
      if (locked.has(a) || locked.has(b)) continue;
      const fa = vf[a]!.filter((fi) => faces[fi]);
      const fb = vf[b]!.filter((fi) => faces[fi]);
      // 둘레가 모두 삼각형이어야 (다각형 면이 끼면 건너뜀)
      if ([...fa, ...fb].some((fi) => faces[fi]!.length !== 3)) continue;
      const shared = fa.filter((fi) => fb.includes(fi));
      if (shared.length !== 2) continue; // 열린 가장자리·이상한 위상
      const opp = shared.map((fi) => faces[fi]!.find((x) => x !== a && x !== b)!);
      const na = nbr(a);
      const nb = nbr(b);
      const common = [...na].filter((x) => nb.has(x));
      if (common.length !== 2 || !opp.every((o) => common.includes(o))) continue; // 링크 조건
      const mid: V3 = [(verts[a]![0] + verts[b]![0]) / 2, (verts[a]![1] + verts[b]![1]) / 2, (verts[a]![2] + verts[b]![2]) / 2];
      // 면 뒤집힘 검사: 남는 둘레 면의 법선이 크게 바뀌면 하지 않는다
      let flips = false;
      for (const fi of [...fa, ...fb]) {
        if (shared.includes(fi)) continue;
        const f = faces[fi]!;
        const before = triNormal(verts[f[0]!]!, verts[f[1]!]!, verts[f[2]!]!);
        const p = f.map((x) => (x === a || x === b ? mid : verts[x]!));
        const after = triNormal(p[0]!, p[1]!, p[2]!);
        const dot = before[0] * after[0] + before[1] * after[1] + before[2] * after[2];
        if (dot <= 0.2 * Math.hypot(...before) * Math.hypot(...after)) {
          flips = true;
          break;
        }
      }
      if (flips) continue;
      verts[a] = mid;
      for (const fi of fb) if (faces[fi]) faces[fi] = faces[fi]!.map((x) => (x === b ? a : x));
      for (const fi of shared) faces[fi] = null;
      alias[b] = a;
      for (const x of [a, b, ...na, ...nb]) locked.add(x);
      done++;
    }
    if (!done) break;
    changed = true;
  }
  if (!changed) return null;
  faces = faces.filter((f) => f && new Set(f).size === f.length);
  // 쓰이지 않는 점 지우고 번호 당기기
  const used = new Uint8Array(verts.length);
  for (const f of faces) for (const v of f!) used[v] = 1;
  const newIdx = new Int32Array(verts.length).fill(-1);
  const out: V3[] = [];
  verts.forEach((v, i) => {
    if (used[i]) {
      newIdx[i] = out.length;
      out.push(v);
    }
  });
  const root = (i: number): number => (alias[i] === i ? i : (alias[i] = root(alias[i]!)));
  const remap = new Int32Array(m.verts.length).map((_, i) => newIdx[root(i)] ?? -1);
  return { mesh: { verts: out, faces: faces.map((f) => f!.map((v) => newIdx[v]!)) }, remap };
}

/** 합치기 뒤 점별 값 옮기기 (같은 점으로 합쳐진 값은 평균) */
export function remapValues(values: ArrayLike<number>, remap: Int32Array, n: number): number[] {
  const sum = new Array<number>(n).fill(0);
  const cnt = new Array<number>(n).fill(0);
  for (let i = 0; i < remap.length; i++) {
    const j = remap[i]!;
    if (j < 0) continue;
    sum[j] = sum[j]! + (values[i] ?? 0);
    cnt[j] = cnt[j]! + 1;
  }
  return sum.map((s, j) => (cnt[j] ? s / cnt[j]! : 0));
}
