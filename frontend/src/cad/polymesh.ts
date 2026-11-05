/**
 * 폴리메시 (형식 v20, 3D 모델링 모드 — 블렌더식 편집): 점 목록 + 다각형 면(점 번호 목록, 바깥에서 볼 때 반시계).
 * 열린 메시(평면 등)도 된다. 모든 연산은 순수 함수: 새 메시를 돌려주고 원본은 바꾸지 않는다 → 명령(mesh_edit)·실행 취소가 같은 경로.
 *
 * 연산 (블렌더 이름): 점 옮기기·돌리기·크기(G/R/S), 면 돌출(E, 영역), 인셋(I, 면마다), 삭제(X: 점·선·면),
 * 루프 컷(Ctrl+R, 사각형 띠), 세분(subdivide, 면마다 가운데 점), 병합(M, 가운데로), 면 채우기(F).
 * 선택은 점 번호로 주고받는다 (선 = 양 끝 점, 면 = 모든 점이 선택된 면) — 블렌더 편집 모드와 같은 규칙.
 */
export type V3 = [number, number, number];
export interface PolyMesh {
  verts: V3[];
  faces: number[][];
}

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
const rv = (p: V3): V3 => [r6(p[0]), r6(p[1]), r6(p[2])];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const len = (a: V3) => Math.hypot(a[0], a[1], a[2]);
const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-12 ? mul(a, 1 / l) : [0, 0, 0];
};
const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

export function centroid(m: PolyMesh, idx: number[]): V3 {
  const c: V3 = [0, 0, 0];
  for (const i of idx) {
    c[0] += m.verts[i]![0];
    c[1] += m.verts[i]![1];
    c[2] += m.verts[i]![2];
  }
  return mul(c, 1 / Math.max(1, idx.length));
}

/** 면 법선 (뉴웰 방법: 오목·비평면 다각형에도 안정) */
export function faceNormal(m: PolyMesh, f: number[]): V3 {
  const n: V3 = [0, 0, 0];
  for (let i = 0; i < f.length; i++) {
    const a = m.verts[f[i]!]!;
    const b = m.verts[f[(i + 1) % f.length]!]!;
    n[0] += (a[1] - b[1]) * (a[2] + b[2]);
    n[1] += (a[2] - b[2]) * (a[0] + b[0]);
    n[2] += (a[0] - b[0]) * (a[1] + b[1]);
  }
  return norm(n);
}

/** 모든 선 (양 끝 점 번호, 작은 번호 먼저) */
export function edges(m: PolyMesh): [number, number][] {
  const seen = new Map<string, [number, number]>();
  for (const f of m.faces)
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!;
      const b = f[(i + 1) % f.length]!;
      if (!seen.has(ekey(a, b))) seen.set(ekey(a, b), a < b ? [a, b] : [b, a]);
    }
  return [...seen.values()];
}

/** 선택한 점으로 고른 면 (모든 점이 선택된 면) */
export function selectedFaces(m: PolyMesh, sel: Set<number>): number[] {
  return m.faces.flatMap((f, i) => (f.every((v) => sel.has(v)) ? [i] : []));
}

/** 삼각형 (화면·내보내기): 면마다 부채꼴 — 볼록 다각형·사각형에 맞다 */
export function triangulate(m: PolyMesh): number[] {
  const out: number[] = [];
  for (const f of m.faces) for (let i = 1; i + 1 < f.length; i++) out.push(f[0]!, f[i]!, f[i + 1]!);
  return out;
}

/** 쓰지 않는 점을 지우고 번호를 다시 매긴다 */
export function compact(m: PolyMesh): PolyMesh {
  const used = new Set(m.faces.flat());
  const map = new Map<number, number>();
  const verts: V3[] = [];
  m.verts.forEach((v, i) => {
    if (used.has(i)) {
      map.set(i, verts.length);
      verts.push(v);
    }
  });
  return { verts, faces: m.faces.map((f) => f.map((i) => map.get(i)!)) };
}

// ── 기본 도형 (블렌더 Shift+A, 원점 = 바닥 중심이 아닌 도형 중심 — 블렌더와 같음) ──────────────────────

export type MeshPrimitive = 'cube' | 'plane' | 'uv_sphere' | 'cylinder' | 'cone' | 'torus' | 'grid';

export interface PrimitiveParams {
  size?: number; // 큐브·평면·격자 한 변
  radius?: number; // 구·원통·원뿔·도넛 큰 반지름
  depth?: number; // 원통·원뿔 높이
  segments?: number; // 둘레 나눔
  rings?: number; // 구 위도 나눔
  minorRadius?: number; // 도넛 작은 반지름
  subdivisions?: number; // 격자 한 방향 칸 수
}

export function primitiveMesh(kind: MeshPrimitive, p: PrimitiveParams = {}): PolyMesh {
  const s = (p.size ?? 2) / 2;
  if (kind === 'cube') {
    const verts: V3[] = [
      [-s, -s, -s], [s, -s, -s], [s, s, -s], [-s, s, -s],
      [-s, -s, s], [s, -s, s], [s, s, s], [-s, s, s],
    ];
    const faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6], [3, 0, 4, 7]];
    return { verts, faces };
  }
  if (kind === 'plane') return { verts: [[-s, -s, 0], [s, -s, 0], [s, s, 0], [-s, s, 0]], faces: [[0, 1, 2, 3]] };
  if (kind === 'grid') {
    const n = Math.max(1, p.subdivisions ?? 10);
    const verts: V3[] = [];
    for (let j = 0; j <= n; j++) for (let i = 0; i <= n; i++) verts.push(rv([-s + (2 * s * i) / n, -s + (2 * s * j) / n, 0]));
    const faces: number[][] = [];
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) faces.push([j * (n + 1) + i, j * (n + 1) + i + 1, (j + 1) * (n + 1) + i + 1, (j + 1) * (n + 1) + i]);
    return { verts, faces };
  }
  const seg = Math.max(3, p.segments ?? 32);
  const r = p.radius ?? 1;
  const ring = (z: number, rad: number): V3[] => Array.from({ length: seg }, (_, i) => rv([rad * Math.cos((2 * Math.PI * i) / seg), rad * Math.sin((2 * Math.PI * i) / seg), z]));
  if (kind === 'cylinder' || kind === 'cone') {
    const h = (p.depth ?? 2) / 2;
    const bottom = ring(-h, r);
    if (kind === 'cone') {
      const verts: V3[] = [...bottom, [0, 0, h]];
      const faces = [Array.from({ length: seg }, (_, i) => seg - 1 - i), ...Array.from({ length: seg }, (_, i) => [i, (i + 1) % seg, seg])];
      return { verts, faces };
    }
    const verts = [...bottom, ...ring(h, r)];
    const faces = [
      Array.from({ length: seg }, (_, i) => seg - 1 - i),
      Array.from({ length: seg }, (_, i) => seg + i),
      ...Array.from({ length: seg }, (_, i) => [i, (i + 1) % seg, seg + ((i + 1) % seg), seg + i]),
    ];
    return { verts, faces };
  }
  if (kind === 'uv_sphere') {
    const rings = Math.max(3, p.rings ?? 16);
    const verts: V3[] = [[0, 0, -r]];
    for (let k = 1; k < rings; k++) {
      const phi = -Math.PI / 2 + (Math.PI * k) / rings;
      verts.push(...ring(r * Math.sin(phi), r * Math.cos(phi)));
    }
    verts.push([0, 0, r]);
    const top = verts.length - 1;
    const at = (k: number, i: number) => 1 + (k - 1) * seg + (i % seg);
    const faces: number[][] = [];
    for (let i = 0; i < seg; i++) faces.push([0, at(1, i + 1), at(1, i)]);
    for (let k = 1; k < rings - 1; k++) for (let i = 0; i < seg; i++) faces.push([at(k, i), at(k, i + 1), at(k + 1, i + 1), at(k + 1, i)]);
    for (let i = 0; i < seg; i++) faces.push([at(rings - 1, i), at(rings - 1, i + 1), top]);
    return { verts, faces };
  }
  // torus
  const minor = p.minorRadius ?? 0.25;
  const minorSeg = Math.max(3, p.rings ?? 12);
  const verts: V3[] = [];
  for (let i = 0; i < seg; i++) {
    const u = (2 * Math.PI * i) / seg;
    for (let j = 0; j < minorSeg; j++) {
      const v = (2 * Math.PI * j) / minorSeg;
      const R = r + minor * Math.cos(v);
      verts.push(rv([R * Math.cos(u), R * Math.sin(u), minor * Math.sin(v)]));
    }
  }
  const at = (i: number, j: number) => (i % seg) * minorSeg + (j % minorSeg);
  const faces: number[][] = [];
  for (let i = 0; i < seg; i++) for (let j = 0; j < minorSeg; j++) faces.push([at(i, j), at(i + 1, j), at(i + 1, j + 1), at(i, j + 1)]);
  return { verts, faces };
}

// ── 편집 연산 ────────────────────────────────────────────────────────────────────────────────

/** 점 옮기기·돌리기·크기 (G/R/S): 4×4 행렬(열 우선, three.js Matrix4.elements 와 같은 순서)을 고른 점에 */
export function transformVerts(m: PolyMesh, idx: number[], e: number[]): PolyMesh {
  const set = new Set(idx);
  const verts = m.verts.map((v, i) => {
    if (!set.has(i)) return v;
    const [x, y, z] = v;
    return rv([e[0]! * x + e[4]! * y + e[8]! * z + e[12]!, e[1]! * x + e[5]! * y + e[9]! * z + e[13]!, e[2]! * x + e[6]! * y + e[10]! * z + e[14]!]);
  });
  return { verts, faces: m.faces };
}

/**
 * 면 돌출 (E, 영역): 고른 면들의 점을 복제해 offset 만큼 옮기고, 영역 둘레 선마다 옆면(사각형)을 만든다.
 * 원래 면은 새 점으로 옮겨진다. 돌려주는 sel = 새 점 (블렌더처럼 돌출 뒤 새 면이 선택된 상태)
 */
export function extrudeFaces(m: PolyMesh, faceIdx: number[], offset: V3): { mesh: PolyMesh; sel: number[] } {
  const chosen = new Set(faceIdx);
  // 영역 둘레 선: 고른 면들 사이에서 한 번만 쓰인 (방향 있는) 선
  const count = new Map<string, number>();
  for (const fi of chosen) {
    const f = m.faces[fi]!;
    for (let i = 0; i < f.length; i++) count.set(ekey(f[i]!, f[(i + 1) % f.length]!), (count.get(ekey(f[i]!, f[(i + 1) % f.length]!)) ?? 0) + 1);
  }
  const verts = [...m.verts];
  const dup = new Map<number, number>();
  const copy = (v: number) => {
    if (!dup.has(v)) {
      dup.set(v, verts.length);
      verts.push(rv(add(m.verts[v]!, offset)));
    }
    return dup.get(v)!;
  };
  const faces = m.faces.map((f, i) => (chosen.has(i) ? f.map(copy) : f));
  for (const fi of chosen) {
    const f = m.faces[fi]!;
    for (let i = 0; i < f.length; i++) {
      const a = f[i]!;
      const b = f[(i + 1) % f.length]!;
      if (count.get(ekey(a, b)) === 1) faces.push([a, b, dup.get(b)!, dup.get(a)!]);
    }
  }
  return { mesh: { verts, faces }, sel: [...dup.values()] };
}

/** 인셋 (I, 면마다): 각 면 안쪽에 같은 모양의 면을 만들고 둘레를 사각형으로. thickness = 점이 안쪽으로 들어가는 거리 */
export function insetFaces(m: PolyMesh, faceIdx: number[], thickness: number): { mesh: PolyMesh; sel: number[] } {
  const verts = [...m.verts];
  const faces = [...m.faces];
  const sel: number[] = [];
  const extra: number[][] = [];
  for (const fi of faceIdx) {
    const f = m.faces[fi]!;
    const c = centroid(m, f);
    const inner = f.map((v) => {
      const p = m.verts[v]!;
      const d = sub(c, p);
      const t = Math.min(thickness, len(d) * 0.999);
      verts.push(rv(add(p, mul(norm(d), t))));
      sel.push(verts.length - 1);
      return verts.length - 1;
    });
    faces[fi] = inner;
    for (let i = 0; i < f.length; i++) extra.push([f[i]!, f[(i + 1) % f.length]!, inner[(i + 1) % f.length]!, inner[i]!]);
  }
  return { mesh: { verts, faces: [...faces, ...extra] }, sel };
}

/** 삭제 (X): 점 = 그 점을 쓰는 면까지, 선 = 그 선을 쓰는 면, 면 = 면만 (남는 외톨이 점은 정리) */
export function deleteElements(m: PolyMesh, sel: number[], mode: 'verts' | 'edges' | 'faces'): PolyMesh {
  const s = new Set(sel);
  let keep: number[][];
  if (mode === 'verts') keep = m.faces.filter((f) => !f.some((v) => s.has(v)));
  else if (mode === 'faces') keep = m.faces.filter((f) => !f.every((v) => s.has(v)));
  else
    keep = m.faces.filter((f) => !f.some((v, i) => s.has(v) && s.has(f[(i + 1) % f.length]!)));
  return compact({ verts: m.verts, faces: keep });
}

/**
 * 루프 컷 (Ctrl+R): 선 (a, b) 를 지나는 사각형 띠를 따라 가며 맞은편 선들의 factor 지점을 잇는 새 고리.
 * 띠가 삼각형·다각형을 만나거나 열린 끝에 닿으면 거기서 멈춘다. 돌려주는 sel = 새 고리의 점
 */
export function loopCut(m: PolyMesh, a: number, b: number, factor = 0.5): { mesh: PolyMesh; sel: number[] } {
  const faceOfEdge = new Map<string, number[]>();
  m.faces.forEach((f, fi) => f.forEach((v, i) => faceOfEdge.set(ekey(v, f[(i + 1) % f.length]!), [...(faceOfEdge.get(ekey(v, f[(i + 1) % f.length]!)) ?? []), fi])));
  // 띠 찾기: 양쪽으로 걸어가며 (사각형, 들어온 선) 기록
  const ring: { face: number; e: [number, number] }[] = [];
  const visited = new Set<number>();
  const walk = (start: [number, number], fromFace: number | null) => {
    let e = start;
    let prev = fromFace;
    for (;;) {
      const next = (faceOfEdge.get(ekey(e[0], e[1])) ?? []).find((fi) => fi !== prev && !visited.has(fi));
      if (next === undefined) return;
      const f = m.faces[next]!;
      if (f.length !== 4) return;
      visited.add(next);
      ring.push({ face: next, e });
      const i = f.findIndex((v, k) => ekey(v, f[(k + 1) % 4]!) === ekey(e[0], e[1]));
      // 맞은편 선 (방향: e[0] 쪽 이웃 → e[1] 쪽 이웃이 되도록)
      const o1 = f[(i + 2) % 4]!;
      const o2 = f[(i + 3) % 4]!;
      const startIsFirst = f[i] === e[0];
      e = startIsFirst ? [o2, o1] : [o1, o2];
      prev = next;
    }
  };
  walk([a, b], null);
  if (!ring.length) return { mesh: m, sel: [] };
  const verts = [...m.verts];
  const mids = new Map<string, number>();
  const mid = (p: number, q: number) => {
    const k = `${p}>${q}`;
    const kr = `${q}>${p}`;
    if (mids.has(k)) return mids.get(k)!;
    if (mids.has(kr)) return mids.get(kr)!;
    verts.push(rv(add(m.verts[p]!, mul(sub(m.verts[q]!, m.verts[p]!), factor))));
    mids.set(k, verts.length - 1);
    return verts.length - 1;
  };
  const faces = [...m.faces];
  const extra: number[][] = [];
  const cut = new Set<number>();
  for (const { face, e } of ring) {
    const f = m.faces[face]!;
    const i = f.findIndex((v, k) => ekey(v, f[(k + 1) % 4]!) === ekey(e[0], e[1]));
    const [v0, v1, v2, v3] = [f[i]!, f[(i + 1) % 4]!, f[(i + 2) % 4]!, f[(i + 3) % 4]!];
    // 선 v0→v1 과 맞은편 v3→v2 를 같은 비율로 (e[0] 기준)
    const m01 = v0 === e[0] ? mid(v0, v1) : mid(v1, v0);
    const m32 = v0 === e[0] ? mid(v3, v2) : mid(v2, v3);
    faces[face] = [v0, m01, m32, v3];
    extra.push([m01, v1, v2, m32]);
    cut.add(m01).add(m32);
  }
  // 띠 바깥에서 같은 선을 쓰던 면(삼각형 등)도 새 점을 끼워 넣어 구멍이 생기지 않게
  const ringFaces = new Set(ring.map((r) => r.face));
  const fixed = faces.map((f, fi) => {
    if (ringFaces.has(fi)) return f;
    const out: number[] = [];
    f.forEach((v, k) => {
      out.push(v);
      const w = f[(k + 1) % f.length]!;
      const k1 = mids.get(`${v}>${w}`) ?? mids.get(`${w}>${v}`);
      if (k1 !== undefined) out.push(k1);
    });
    return out;
  });
  return { mesh: { verts, faces: [...fixed, ...extra] }, sel: [...cut] };
}

/** 세분 (면마다): 선 가운데 점 + 면 가운데 점으로 n각형 → 사각형 n개 (모양은 그대로, 매끈하게는 모디파이어 몫) */
export function subdivideFaces(m: PolyMesh, faceIdx: number[]): PolyMesh {
  const chosen = new Set(faceIdx);
  const verts = [...m.verts];
  const mids = new Map<string, number>();
  const mid = (a: number, b: number) => {
    const k = ekey(a, b);
    if (!mids.has(k)) {
      verts.push(rv(mul(add(m.verts[a]!, m.verts[b]!), 0.5)));
      mids.set(k, verts.length - 1);
    }
    return mids.get(k)!;
  };
  const faces: number[][] = [];
  m.faces.forEach((f, fi) => {
    if (!chosen.has(fi)) return;
    verts.push(rv(centroid(m, f)));
    const c = verts.length - 1;
    f.forEach((v, i) => faces.push([v, mid(v, f[(i + 1) % f.length]!), c, mid(f[(i - 1 + f.length) % f.length]!, v)]));
  });
  // 고르지 않은 면도 나뉜 선에는 새 점을 끼운다 (갈라짐 방지)
  const rest = m.faces.flatMap((f, fi) => {
    if (chosen.has(fi)) return [];
    const out: number[] = [];
    f.forEach((v, k) => {
      out.push(v);
      const w = f[(k + 1) % f.length]!;
      const mk = mids.get(ekey(v, w));
      if (mk !== undefined) out.push(mk);
    });
    return [out];
  });
  return { verts, faces: [...rest, ...faces] };
}

/** 병합 (M, 가운데로): 고른 점들을 가운데 한 점으로 합치고, 그 때문에 퇴화한 면(점 3개 미만)은 지운다 */
export function mergeVerts(m: PolyMesh, idx: number[]): PolyMesh {
  if (idx.length < 2) return m;
  const target = idx[0]!;
  const s = new Set(idx);
  const verts = m.verts.map((v, i) => (i === target ? rv(centroid(m, idx)) : v));
  const faces = m.faces
    .map((f) => f.map((v) => (s.has(v) ? target : v)).filter((v, i, arr) => v !== arr[(i - 1 + arr.length) % arr.length]))
    .filter((f) => new Set(f).size >= 3);
  return compact({ verts, faces });
}

/** 면 채우기 (F): 고른 점들로 면 하나 (점 순서 = 고른 순서). 이미 같은 면이 있으면 그대로 */
export function fillFace(m: PolyMesh, idx: number[]): PolyMesh {
  if (idx.length < 3 || new Set(idx).size !== idx.length) return m;
  const key = [...idx].sort((x, y) => x - y).join(',');
  if (m.faces.some((f) => [...f].sort((x, y) => x - y).join(',') === key)) return m;
  return { verts: m.verts, faces: [...m.faces, idx] };
}

/** 메시가 이상하지 않은지 (명령 검증): 점 번호 범위, 면 크기 3 이상, 한 면 안 같은 점 반복 없음 */
export function polyMeshError(m: PolyMesh): string | null {
  for (const [fi, f] of m.faces.entries()) {
    if (f.length < 3) return `면 ${fi} 의 점이 3개보다 적습니다`;
    if (new Set(f).size !== f.length) return `면 ${fi} 에 같은 점이 두 번 있습니다`;
    if (f.some((v) => v < 0 || v >= m.verts.length || !Number.isInteger(v))) return `면 ${fi} 가 없는 점을 가리킵니다`;
  }
  return null;
}

/** 부피 (닫힌 메시일 때 의미 있음, 테스트·질량 특성) */
export function polyVolume(m: PolyMesh): number {
  const t = triangulate(m);
  let v = 0;
  for (let i = 0; i < t.length; i += 3) {
    const a = m.verts[t[i]!]!;
    const b = m.verts[t[i + 1]!]!;
    const c = m.verts[t[i + 2]!]!;
    v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6;
  }
  return v;
}

/** 열린 선(한 면에만 쓰인 선) 수 — 0 이면 닫힌 메시 */
export function boundaryEdgeCount(m: PolyMesh): number {
  const c = new Map<string, number>();
  for (const f of m.faces) for (let i = 0; i < f.length; i++) c.set(ekey(f[i]!, f[(i + 1) % f.length]!), (c.get(ekey(f[i]!, f[(i + 1) % f.length]!)) ?? 0) + 1);
  return [...c.values()].filter((n) => n === 1).length;
}

export { cross as cross3, norm as normalize3 };
