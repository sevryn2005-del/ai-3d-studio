/**
 * 두께 분석 (솔리드웍스 Thickness Analysis): 삼각형마다 가운데에서 법선 반대쪽(안쪽)으로 광선을 쏴
 * 처음 만나는 다른 면까지 거리 = 그 자리 벽 두께. 한계보다 얇으면 빨강, 두꺼울수록 초록 → 파랑.
 * 화면 분석만 (저장 형식 무관). 광선 검사는 삼각형 경계 상자 나무(BVH)로 빠르게.
 */
import { BufferAttribute, type BufferGeometry } from 'three';
import { create } from 'zustand';

interface Node {
  min: [number, number, number];
  max: [number, number, number];
  /** 잎: 삼각형 번호, 가지: 자식 둘 */
  tris?: number[];
  left?: Node;
  right?: Node;
}

const LEAF = 8;

function build(tris: number[], pos: ArrayLike<number>, cent: Float64Array): Node {
  const min: [number, number, number] = [Infinity, Infinity, Infinity];
  const max: [number, number, number] = [-Infinity, -Infinity, -Infinity];
  for (const t of tris)
    for (let k = 0; k < 3; k++)
      for (let a = 0; a < 3; a++) {
        const v = pos[(t * 3 + k) * 3 + a]!;
        if (v < min[a]!) min[a] = v;
        if (v > max[a]!) max[a] = v;
      }
  if (tris.length <= LEAF) return { min, max, tris };
  const ext = [max[0] - min[0], max[1] - min[1], max[2] - min[2]];
  const axis = ext[0]! >= ext[1]! && ext[0]! >= ext[2]! ? 0 : ext[1]! >= ext[2]! ? 1 : 2;
  const sorted = [...tris].sort((a, b) => cent[a * 3 + axis]! - cent[b * 3 + axis]!);
  const mid = sorted.length >> 1;
  return { min, max, left: build(sorted.slice(0, mid), pos, cent), right: build(sorted.slice(mid), pos, cent) };
}

/** 광선-상자: 들어가는 거리 (안 맞으면 Infinity) */
function boxHit(n: Node, o: number[], inv: number[], best: number): number {
  let t0 = 0;
  let t1 = best;
  for (let a = 0; a < 3; a++) {
    let ta = (n.min[a]! - o[a]!) * inv[a]!;
    let tb = (n.max[a]! - o[a]!) * inv[a]!;
    if (ta > tb) [ta, tb] = [tb, ta];
    if (ta > t0) t0 = ta;
    if (tb < t1) t1 = tb;
    if (t0 > t1) return Infinity;
  }
  return t0;
}

/** 광선-삼각형 (Möller–Trumbore, 양면) */
function triHit(pos: ArrayLike<number>, t: number, o: number[], d: number[]): number {
  const i = t * 9;
  const e1 = [pos[i + 3]! - pos[i]!, pos[i + 4]! - pos[i + 1]!, pos[i + 5]! - pos[i + 2]!];
  const e2 = [pos[i + 6]! - pos[i]!, pos[i + 7]! - pos[i + 1]!, pos[i + 8]! - pos[i + 2]!];
  const p = [d[1]! * e2[2]! - d[2]! * e2[1]!, d[2]! * e2[0]! - d[0]! * e2[2]!, d[0]! * e2[1]! - d[1]! * e2[0]!];
  const det = e1[0]! * p[0]! + e1[1]! * p[1]! + e1[2]! * p[2]!;
  if (Math.abs(det) < 1e-14) return Infinity;
  const inv = 1 / det;
  const s = [o[0]! - pos[i]!, o[1]! - pos[i + 1]!, o[2]! - pos[i + 2]!];
  const u = (s[0]! * p[0]! + s[1]! * p[1]! + s[2]! * p[2]!) * inv;
  if (u < -1e-9 || u > 1 + 1e-9) return Infinity;
  const q = [s[1]! * e1[2]! - s[2]! * e1[1]!, s[2]! * e1[0]! - s[0]! * e1[2]!, s[0]! * e1[1]! - s[1]! * e1[0]!];
  const v = (d[0]! * q[0]! + d[1]! * q[1]! + d[2]! * q[2]!) * inv;
  if (v < -1e-9 || u + v > 1 + 1e-9) return Infinity;
  return (e2[0]! * q[0]! + e2[1]! * q[1]! + e2[2]! * q[2]!) * inv;
}

/**
 * 삼각형별 두께 (mm). pos = 인덱스 없는 삼각형 점 (9개씩). 안쪽으로 아무것도 안 맞으면 Infinity (열린 메시).
 * 자기 자신과 아주 가까운 맞음(eps)은 건너뛴다.
 */
export function triangleThickness(pos: ArrayLike<number>): Float64Array {
  const n = Math.floor(pos.length / 9);
  const cent = new Float64Array(n * 3);
  for (let t = 0; t < n; t++)
    for (let a = 0; a < 3; a++) cent[t * 3 + a] = (pos[t * 9 + a]! + pos[t * 9 + 3 + a]! + pos[t * 9 + 6 + a]!) / 3;
  const root = n ? build([...Array(n).keys()], pos, cent) : null;
  const out = new Float64Array(n).fill(Infinity);
  if (!root) return out;
  const size = Math.max(root.max[0] - root.min[0], root.max[1] - root.min[1], root.max[2] - root.min[2]);
  const eps = Math.max(1e-6, size * 1e-7);
  for (let t = 0; t < n; t++) {
    const i = t * 9;
    const e1 = [pos[i + 3]! - pos[i]!, pos[i + 4]! - pos[i + 1]!, pos[i + 5]! - pos[i + 2]!];
    const e2 = [pos[i + 6]! - pos[i]!, pos[i + 7]! - pos[i + 1]!, pos[i + 8]! - pos[i + 2]!];
    const nx = e1[1]! * e2[2]! - e1[2]! * e2[1]!;
    const ny = e1[2]! * e2[0]! - e1[0]! * e2[2]!;
    const nz = e1[0]! * e2[1]! - e1[1]! * e2[0]!;
    const l = Math.hypot(nx, ny, nz);
    if (l < 1e-14) continue;
    const d = [-nx / l, -ny / l, -nz / l];
    const o = [cent[t * 3]!, cent[t * 3 + 1]!, cent[t * 3 + 2]!];
    const inv = d.map((x) => (Math.abs(x) < 1e-15 ? 1e15 : 1 / x));
    let best = Infinity;
    const stack: Node[] = [root];
    while (stack.length) {
      const node = stack.pop()!;
      if (boxHit(node, o, inv, best) === Infinity) continue;
      if (node.tris) {
        for (const u of node.tris) {
          if (u === t) continue;
          const h = triHit(pos, u, o, d);
          if (h > eps && h < best) best = h;
        }
      } else stack.push(node.left!, node.right!);
    }
    out[t] = best;
  }
  return out;
}

/** 두께 → 색: 한계 미만 빨강, 한계 → 한계×3 사이 노랑 → 초록, 그 위 파랑 쪽. 안 맞음(열림) = 회색 */
export function thicknessColor(th: number, limit: number): [number, number, number] {
  if (!Number.isFinite(th)) return [0.6, 0.6, 0.6];
  if (th < limit) return [0.86, 0.2, 0.18];
  const t = Math.min(1, (th - limit) / (limit * 3));
  // 노랑 (0.97,0.8,0.15) → 초록 (0.2,0.72,0.33) → 파랑 (0.25,0.45,0.9)
  if (t < 0.5) {
    const k = t * 2;
    return [0.97 + (0.2 - 0.97) * k, 0.8 + (0.72 - 0.8) * k, 0.15 + (0.33 - 0.15) * k];
  }
  const k = (t - 0.5) * 2;
  return [0.2 + (0.25 - 0.2) * k, 0.72 + (0.45 - 0.72) * k, 0.33 + (0.9 - 0.33) * k];
}

export interface ThicknessStats {
  /** 가장 얇은 곳 (mm, 열린 메시만이면 Infinity) */
  min: number;
  /** 한계보다 얇은 넓이 (mm²) */
  thinArea: number;
  totalArea: number;
}

/** 화면용: 메시(객체 로컬) → 인덱스 없는 복사본 + 삼각형별 색, 통계 */
export function thicknessGeometry(g: BufferGeometry, limit: number): { geometry: BufferGeometry; stats: ThicknessStats } {
  const out = g.index ? g.toNonIndexed() : g.clone();
  out.deleteAttribute('normal');
  out.computeVertexNormals();
  const p = out.getAttribute('position').array;
  const th = triangleThickness(p);
  const colors = new Float32Array((p.length / 9) * 9);
  const stats: ThicknessStats = { min: Infinity, thinArea: 0, totalArea: 0 };
  th.forEach((v, t) => {
    const i = t * 9;
    const e1 = [p[i + 3]! - p[i]!, p[i + 4]! - p[i + 1]!, p[i + 5]! - p[i + 2]!];
    const e2 = [p[i + 6]! - p[i]!, p[i + 7]! - p[i + 1]!, p[i + 8]! - p[i + 2]!];
    const area = Math.hypot(e1[1]! * e2[2]! - e1[2]! * e2[1]!, e1[2]! * e2[0]! - e1[0]! * e2[2]!, e1[0]! * e2[1]! - e1[1]! * e2[0]!) / 2;
    stats.totalArea += area;
    if (v < stats.min) stats.min = v;
    if (v < limit) stats.thinArea += area;
    const c = thicknessColor(v, limit);
    for (let k = 0; k < 3; k++) colors.set(c, (t * 3 + k) * 3);
  });
  out.setAttribute('color', new BufferAttribute(colors, 3));
  return { geometry: out, stats };
}

/** 객체별 통계 (패널이 모아 보여 줌) */
export const useThicknessStats = create<{ byObject: Record<string, ThicknessStats>; put: (id: string, s: ThicknessStats | null) => void }>((set) => ({
  byObject: {},
  put: (id, st) =>
    set((s) => {
      const next = { ...s.byObject };
      if (st) next[id] = st;
      else delete next[id];
      return { byObject: next };
    }),
}));
