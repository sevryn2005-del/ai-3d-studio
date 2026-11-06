/**
 * 복셀 리메시 (블렌더 Voxel Remesh, 스컬프트 Ctrl+R): 모양을 균일한 사각형 그물로 다시 짠다 — 순수 함수.
 * 스컬프트로 늘어난 면을 고르게 하고, 겹친 조각을 하나로 합친다 (구멍·틈은 복셀 크기보다 작으면 메워진다).
 *
 * 1. 격자 기둥(z 방향)마다 삼각형과 만나는 높이와 방향(들어감 +1 / 나감 −1)을 모아 감은 수 > 0 = 안 (겹친 조각도 합집합)
 * 2. x·y·z 세 방향 기둥의 교차점으로 격자 선 위 정확한 표면 위치
 * 3. Surface Nets: 안팎이 섞인 칸마다 점 하나(교차점 평균), 안팎이 바뀌는 격자 선마다 사각형 하나 → 모두 사각형, 닫힘
 * 4. Taubin 다듬기(부피를 거의 유지하는 매끈하게) 몇 번
 */
import { triangulate, type PolyMesh, type V3 } from './polymesh';

export const MAX_REMESH_CELLS = 2_000_000;

export function remeshCellCount(m: PolyMesh, voxel: number): number {
  if (!m.verts.length || voxel <= 0) return 0;
  const lo = [0, 1, 2].map((a) => Math.min(...m.verts.map((v) => v[a]!)));
  const hi = [0, 1, 2].map((a) => Math.max(...m.verts.map((v) => v[a]!)));
  return lo.reduce((n, l, a) => n * (Math.ceil((hi[a]! - l) / voxel) + 4), 1);
}

export function voxelRemesh(m: PolyMesh, voxel: number, smooth = 2): PolyMesh | string {
  if (!(voxel > 0)) return '리메시: 복셀 크기는 0 보다 커야 합니다';
  if (m.faces.length === 0) return '리메시: 면이 없습니다';
  const cells = remeshCellCount(m, voxel);
  if (cells > MAX_REMESH_CELLS) return `리메시: 복셀이 너무 작습니다 (격자 ${Math.round(cells / 1e6)}백만 칸 — 복셀 크기를 키우세요)`;
  const h = voxel;
  // 격자 원점을 아주 조금 비켜 점·선이 삼각형 꼭짓점에 딱 걸리지 않게
  const jitter = [0.000137, 0.000241, 0.000353].map((j) => j * h);
  const lo = [0, 1, 2].map((a) => Math.min(...m.verts.map((v) => v[a]!)) - 2 * h + jitter[a]!);
  const n = [0, 1, 2].map((a) => Math.ceil((Math.max(...m.verts.map((v) => v[a]!)) - lo[a]!) / h) + 2);
  const [nx, ny, nz] = n as [number, number, number];
  const P = (a: number, i: number) => lo[a]! + i * h;
  const idx = (i: number, j: number, k: number) => (k * (ny + 1) + j) * (nx + 1) + i;
  const tri = triangulate(m);
  const V = m.verts;

  /** 축 a 방향 기둥들: 다른 두 축(b, c) 격자점마다 교차 좌표(정렬)와 방향 */
  type Column = { t: Float64Array; s: Int8Array };
  const columns = (a: number): Column[][] => {
    const b = (a + 1) % 3;
    const c = (a + 2) % 3;
    const nb = n[b]! + 1;
    const nc = n[c]! + 1;
    const lists: [number, number][][] = Array.from({ length: nb * nc }, () => []);
    for (let t = 0; t < tri.length; t += 3) {
      const p0 = V[tri[t]!]!;
      const p1 = V[tri[t + 1]!]!;
      const p2 = V[tri[t + 2]!]!;
      const ib0 = Math.max(0, Math.ceil((Math.min(p0[b]!, p1[b]!, p2[b]!) - lo[b]!) / h));
      const ib1 = Math.min(nb - 1, Math.floor((Math.max(p0[b]!, p1[b]!, p2[b]!) - lo[b]!) / h));
      const ic0 = Math.max(0, Math.ceil((Math.min(p0[c]!, p1[c]!, p2[c]!) - lo[c]!) / h));
      const ic1 = Math.min(nc - 1, Math.floor((Math.max(p0[c]!, p1[c]!, p2[c]!) - lo[c]!) / h));
      // (b, c) 평면에 투영한 삼각형의 무게중심 좌표
      const x0 = p0[b]!, y0 = p0[c]!;
      const d = (p1[b]! - x0) * (p2[c]! - y0) - (p2[b]! - x0) * (p1[c]! - y0);
      if (Math.abs(d) < 1e-18) continue;
      // 축 a 방향으로 갈 때 들어감(+1, 법선이 −a 쪽) / 나감(−1): 투영 넓이 부호 = 법선의 a 성분 부호
      const dir = d > 0 ? -1 : 1;
      for (let ib = ib0; ib <= ib1; ib++) {
        const x = P(b, ib);
        for (let ic = ic0; ic <= ic1; ic++) {
          const y = P(c, ic);
          const u = ((x - x0) * (p2[c]! - y0) - (p2[b]! - x0) * (y - y0)) / d;
          const v = ((p1[b]! - x0) * (y - y0) - (x - x0) * (p1[c]! - y0)) / d;
          if (u < 0 || v < 0 || u + v > 1) continue;
          lists[ic * nb + ib]!.push([p0[a]! + u * (p1[a]! - p0[a]!) + v * (p2[a]! - p0[a]!), dir]);
        }
      }
    }
    const out: Column[][] = [];
    for (let ic = 0; ic < nc; ic++) {
      const row: Column[] = [];
      for (let ib = 0; ib < nb; ib++) {
        const l = lists[ic * nb + ib]!.sort((x, y) => x[0] - y[0]);
        row.push({ t: Float64Array.from(l, (x) => x[0]), s: Int8Array.from(l, (x) => x[1]) });
      }
      out.push(row);
    }
    return out;
  };
  const colZ = columns(2); // [ix(c=0)? ] — 축 2: b = 0(x), c = 1(y) → colZ[j][i]
  const colX = columns(0); // b = 1(y), c = 2(z) → colX[k][j]
  const colY = columns(1); // b = 2(z), c = 0(x) → colY[i][k]

  // 안/밖: z 기둥의 감은 수
  const inside = new Uint8Array((nx + 1) * (ny + 1) * (nz + 1));
  for (let j = 0; j <= ny; j++)
    for (let i = 0; i <= nx; i++) {
      const { t: zs, s: ss } = colZ[j]![i]!;
      let p = 0;
      let w = 0;
      for (let k = 0; k <= nz; k++) {
        const z = P(2, k);
        while (p < zs.length && zs[p]! < z) w += ss[p++]!;
        if (w > 0) inside[idx(i, j, k)] = 1;
      }
    }
  /** 격자 선 위 교차점 (축 a, 낮은 쪽 끝 i,j,k) — 그 구간에 교차가 없으면 가운데 */
  const crossing = (a: number, i: number, j: number, k: number): number => {
    const list = (a === 0 ? colX[k]![j]! : a === 1 ? colY[i]![k]! : colZ[j]![i]!).t;
    const s = a === 0 ? i : a === 1 ? j : k;
    const t0 = P(a, s);
    const t1 = P(a, s + 1);
    for (const t of list) if (t >= t0 && t <= t1) return t;
    return (t0 + t1) / 2;
  };

  // 칸마다 점 (안팎이 섞인 칸만)
  const cellVert = new Int32Array(nx * ny * nz).fill(-1);
  const cidx = (i: number, j: number, k: number) => (k * ny + j) * nx + i;
  const verts: V3[] = [];
  const EDGES: [number, number, number, number][] = [
    // 축, 시작 꼭짓점 오프셋 (dx, dy, dz)
    [0, 0, 0, 0], [0, 0, 1, 0], [0, 0, 0, 1], [0, 0, 1, 1],
    [1, 0, 0, 0], [1, 1, 0, 0], [1, 0, 0, 1], [1, 1, 0, 1],
    [2, 0, 0, 0], [2, 1, 0, 0], [2, 0, 1, 0], [2, 1, 1, 0],
  ];
  for (let k = 0; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        let any = 0;
        for (let c = 0; c < 8; c++) any += inside[idx(i + (c & 1), j + ((c >> 1) & 1), k + ((c >> 2) & 1))]!;
        if (any === 0 || any === 8) continue;
        let sx = 0, sy = 0, sz = 0, cnt = 0;
        for (const [a, dx, dy, dz] of EDGES) {
          const [i0, j0, k0] = [i + dx, j + dy, k + dz];
          const [i1, j1, k1] = [i0 + (a === 0 ? 1 : 0), j0 + (a === 1 ? 1 : 0), k0 + (a === 2 ? 1 : 0)];
          if (inside[idx(i0, j0, k0)] === inside[idx(i1, j1, k1)]) continue;
          const t = crossing(a, i0, j0, k0);
          sx += a === 0 ? t : P(0, i0);
          sy += a === 1 ? t : P(1, j0);
          sz += a === 2 ? t : P(2, k0);
          cnt++;
        }
        cellVert[cidx(i, j, k)] = verts.length;
        verts.push([sx / cnt, sy / cnt, sz / cnt]);
      }
  if (verts.length > 50_000) return `리메시: 점이 ${verts.length.toLocaleString()}개로 한도(50,000)를 넘습니다 — 복셀 크기를 키우세요`;

  // 안팎이 바뀌는 격자 선마다 사각형 (둘레 칸 4개의 점), 바깥 쪽이 앞면
  const faces: number[][] = [];
  const quad = (q: number[], flip: boolean) => {
    if (q.some((x) => x < 0)) return;
    faces.push(flip ? [q[0]!, q[3]!, q[2]!, q[1]!] : q);
  };
  for (let k = 1; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 0; i < nx; i++) {
        const a = inside[idx(i, j, k)]!;
        if (a === inside[idx(i + 1, j, k)]) continue;
        quad([cellVert[cidx(i, j - 1, k - 1)]!, cellVert[cidx(i, j, k - 1)]!, cellVert[cidx(i, j, k)]!, cellVert[cidx(i, j - 1, k)]!], !a);
      }
  for (let k = 1; k < nz; k++)
    for (let j = 0; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const a = inside[idx(i, j, k)]!;
        if (a === inside[idx(i, j + 1, k)]) continue;
        quad([cellVert[cidx(i - 1, j, k - 1)]!, cellVert[cidx(i - 1, j, k)]!, cellVert[cidx(i, j, k)]!, cellVert[cidx(i, j, k - 1)]!], !a);
      }
  for (let k = 0; k < nz; k++)
    for (let j = 1; j < ny; j++)
      for (let i = 1; i < nx; i++) {
        const a = inside[idx(i, j, k)]!;
        if (a === inside[idx(i, j, k + 1)]) continue;
        quad([cellVert[cidx(i - 1, j - 1, k)]!, cellVert[cidx(i, j - 1, k)]!, cellVert[cidx(i, j, k)]!, cellVert[cidx(i - 1, j, k)]!], !a);
      }
  if (!faces.length) return '리메시: 결과가 비었습니다 (닫힌 메시인지, 복셀이 모양보다 작은지 확인하세요)';
  if (faces.length > 50_000) return `리메시: 면이 ${faces.length.toLocaleString()}개로 한도(50,000)를 넘습니다 — 복셀 크기를 키우세요`;

  // Taubin 다듬기 (λ 0.5 / μ −0.53): 계단을 펴되 부피는 거의 그대로
  const nb: Set<number>[] = verts.map(() => new Set());
  for (const f of faces) f.forEach((v, q) => {
    nb[v]!.add(f[(q + 1) % 4]!);
    nb[v]!.add(f[(q + 3) % 4]!);
  });
  let cur = verts;
  for (let it = 0; it < smooth * 2; it++) {
    const lam = it % 2 === 0 ? 0.5 : -0.53;
    cur = cur.map((p, v) => {
      const s = nb[v]!;
      if (!s.size) return p;
      let ax = 0, ay = 0, az = 0;
      for (const w of s) {
        ax += cur[w]![0];
        ay += cur[w]![1];
        az += cur[w]![2];
      }
      return [p[0] + lam * (ax / s.size - p[0]), p[1] + lam * (ay / s.size - p[1]), p[2] + lam * (az / s.size - p[2])];
    });
  }
  const r6 = (x: number) => Math.round(x * 1e6) / 1e6 + 0;
  return { verts: cur.map((p) => [r6(p[0]), r6(p[1]), r6(p[2])]), faces };
}
