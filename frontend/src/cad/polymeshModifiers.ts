/**
 * 메시 모디파이어 (형식 v22, 블렌더 모디파이어 스택) — 순수 함수. 원본 메시는 그대로 두고 위에서부터 차례로 적용한 결과를
 * 화면·내보내기·세 엔진이 쓴다. 서버 app/cad/polymesh.py 가 같은 규칙(같은 점·면 순서)으로 계산한다.
 *
 * - subsurf: 캐트멀-클락 세분 (levels 번). 열린 가장자리는 가장자리 규칙(1:6:1)
 * - mirror: 객체 로컬 축 평면(원점)에 대칭 복사. merge 면 평면 위 점을 합치고 평면 위 면(안쪽 면)은 지운다
 * - array: 같은 메시를 offset 만큼씩 count 개 (상대 아님, mm)
 * - solidify: 점 법선 반대쪽으로 thickness 만큼 안쪽 면을 만들고 열린 가장자리는 옆면으로 닫는다
 * - smooth (형식 v31): 라플라스 매끈하게 — 점마다 이웃 평균 쪽으로 factor 만큼, repeat 번 (모든 점, 블렌더 Smooth 와 같음)
 * - decimate (형식 v31): 면 줄이기 — 삼각형으로 나눈 뒤 짧은 선부터 합쳐(가운데 점) 삼각형 수를 ratio 배로.
 *   열린 가장자리·뒤집히는 면·꼬이는 연결(이웃 공유 ≠ 2)은 건너뛴다 → 닫힌 메시는 닫힌 채로
 */
import { centroid, faceNormal, type PolyMesh, type V3 } from './polymesh';

export type Modifier =
  | { type: 'subsurf'; levels: number }
  | { type: 'mirror'; axis: 'x' | 'y' | 'z'; merge: boolean }
  | { type: 'array'; count: number; offset: V3 }
  | { type: 'solidify'; thickness: number }
  | { type: 'smooth'; factor: number; repeat: number }
  | { type: 'decimate'; ratio: number };

export const MODIFIER_LABEL: Record<Modifier['type'], string> = {
  subsurf: '세분 표면',
  mirror: '미러',
  array: '배열',
  solidify: '두께',
  smooth: '매끈하게',
  decimate: '면 줄이기',
};

/** 결과 메시가 이보다 크면 거부 (브라우저가 멈추지 않도록) */
export const MAX_EVALUATED_FACES = 200_000;

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
const rv = (p: V3): V3 => [r6(p[0]), r6(p[1]), r6(p[2])];
const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const mul = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

/** 캐트멀-클락 세분 한 번. 새 점 순서 = 원래 점 → 선 점(면을 돌며 처음 만난 순서) → 면 점 */
export function catmullClark(m: PolyMesh): PolyMesh {
  const V = m.verts.length;
  const edgeIdx = new Map<string, number>();
  const edgeList: [number, number][] = [];
  const edgeFaces: number[][] = [];
  m.faces.forEach((f, fi) =>
    f.forEach((a, i) => {
      const b = f[(i + 1) % f.length]!;
      const k = ekey(a, b);
      let e = edgeIdx.get(k);
      if (e === undefined) {
        e = edgeList.length;
        edgeIdx.set(k, e);
        edgeList.push([a, b]);
        edgeFaces.push([]);
      }
      edgeFaces[e]!.push(fi);
    }),
  );
  const E = edgeList.length;
  const facePts = m.faces.map((f) => centroid(m, f));
  const edgePts = edgeList.map(([a, b], e) => {
    const fs = edgeFaces[e]!;
    const s = add(m.verts[a]!, m.verts[b]!);
    return fs.length === 2 ? mul(add(s, add(facePts[fs[0]!]!, facePts[fs[1]!]!)), 0.25) : mul(s, 0.5);
  });
  const vFaces: number[][] = m.verts.map(() => []);
  m.faces.forEach((f, fi) => f.forEach((v) => vFaces[v]!.push(fi)));
  const vEdges: number[][] = m.verts.map(() => []);
  edgeList.forEach(([a, b], e) => {
    vEdges[a]!.push(e);
    vEdges[b]!.push(e);
  });
  const vertPts = m.verts.map((p, v): V3 => {
    const es = vEdges[v]!;
    if (!es.length) return p;
    const boundary = es.filter((e) => edgeFaces[e]!.length !== 2);
    if (boundary.length) {
      if (boundary.length !== 2) return p; // 가장자리가 갈라지는 점(모서리 점)은 그대로
      const [n1, n2] = boundary.map((e) => {
        const [a, b] = edgeList[e]!;
        return m.verts[a === v ? b : a]!;
      });
      return mul(add(add(n1!, n2!), mul(p, 6)), 1 / 8);
    }
    const n = es.length;
    const F = mul(vFaces[v]!.reduce<V3>((s, fi) => add(s, facePts[fi]!), [0, 0, 0]), 1 / vFaces[v]!.length);
    const R = mul(
      es.reduce<V3>((s, e) => {
        const [a, b] = edgeList[e]!;
        return add(s, mul(add(m.verts[a]!, m.verts[b]!), 0.5));
      }, [0, 0, 0]),
      1 / n,
    );
    return mul(add(add(F, mul(R, 2)), mul(p, n - 3)), 1 / n);
  });
  const faces: number[][] = [];
  m.faces.forEach((f, fi) => {
    const k = f.length;
    for (let i = 0; i < k; i++) {
      const prev = f[(i - 1 + k) % k]!;
      const cur = f[i]!;
      const next = f[(i + 1) % k]!;
      faces.push([cur, V + edgeIdx.get(ekey(cur, next))!, V + E + fi, V + edgeIdx.get(ekey(prev, cur))!]);
    }
  });
  return { verts: [...vertPts, ...edgePts, ...facePts].map(rv), faces };
}

const AXIS = { x: 0, y: 1, z: 2 } as const;
const MERGE_TOL = 1e-4;

export function mirrorMesh(m: PolyMesh, axis: 'x' | 'y' | 'z', merge: boolean): PolyMesh {
  const ax = AXIS[axis];
  const on = m.verts.map((p) => merge && Math.abs(p[ax]) <= MERGE_TOL);
  const verts: V3[] = m.verts.map((p, i) => {
    if (!on[i]) return p;
    const q: V3 = [...p];
    q[ax] = 0;
    return q;
  });
  const map: number[] = [];
  m.verts.forEach((p, i) => {
    if (on[i]) map.push(i);
    else {
      const q: V3 = [...p];
      q[ax] = -q[ax];
      map.push(verts.length);
      verts.push(q);
    }
  });
  const keep = (f: number[]) => !(merge && f.every((v) => on[v]));
  const faces = [...m.faces.filter(keep), ...m.faces.filter(keep).map((f) => f.map((v) => map[v]!).reverse())];
  return { verts: verts.map(rv), faces };
}

export function arrayMesh(m: PolyMesh, count: number, offset: V3): PolyMesh {
  const verts: V3[] = [];
  const faces: number[][] = [];
  for (let k = 0; k < count; k++) {
    const base = verts.length;
    for (const p of m.verts) verts.push(rv(add(p, mul(offset, k))));
    for (const f of m.faces) faces.push(f.map((v) => v + base));
  }
  return { verts, faces };
}

export function solidifyMesh(m: PolyMesh, thickness: number): PolyMesh {
  const V = m.verts.length;
  const normals: V3[] = m.verts.map(() => [0, 0, 0]);
  for (const f of m.faces) {
    const n = faceNormal(m, f);
    for (const v of f) normals[v] = add(normals[v]!, n);
  }
  const inner = m.verts.map((p, i) => {
    const n = normals[i]!;
    const l = Math.hypot(...n);
    return l > 1e-12 ? add(p, mul(n, -thickness / l)) : p;
  });
  const count = new Map<string, number>();
  for (const f of m.faces) f.forEach((a, i) => count.set(ekey(a, f[(i + 1) % f.length]!), (count.get(ekey(a, f[(i + 1) % f.length]!)) ?? 0) + 1));
  const faces = [...m.faces, ...m.faces.map((f) => f.map((v) => v + V).reverse())];
  for (const f of m.faces)
    f.forEach((a, i) => {
      const b = f[(i + 1) % f.length]!;
      if (count.get(ekey(a, b)) === 1) faces.push([b, a, a + V, b + V]);
    });
  return { verts: [...m.verts, ...inner].map(rv), faces };
}

/** 점마다 이웃(선으로 이어진 점, 면을 돌며 처음 만난 순서) — 서버 _neighbors 와 같은 순서 */
function neighbors(m: PolyMesh): number[][] {
  const out: number[][] = m.verts.map(() => []);
  const link = (a: number, b: number) => {
    if (!out[a]!.includes(b)) out[a]!.push(b);
  };
  for (const f of m.faces)
    f.forEach((a, i) => {
      const b = f[(i + 1) % f.length]!;
      link(a, b);
      link(b, a);
    });
  return out;
}

export function smoothMesh(m: PolyMesh, factor: number, repeat: number): PolyMesh {
  const nb = neighbors(m);
  let verts = m.verts;
  for (let r = 0; r < repeat; r++) {
    const cur = verts;
    verts = cur.map((p, i) => {
      const ns = nb[i]!;
      if (!ns.length) return p;
      let c: V3 = [0, 0, 0];
      for (const j of ns) c = add(c, cur[j]!);
      c = mul(c, 1 / ns.length);
      return rv(add(p, mul([c[0] - p[0], c[1] - p[1], c[2] - p[2]], factor)));
    });
  }
  return { verts, faces: m.faces };
}

const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** 면 줄이기 (짧은 선 합치기). 한 번 돌 때 합친 점과 그 이웃은 잠가서 같은 차례의 연결 정보가 맞게 한다 */
export function decimateMesh(m: PolyMesh, ratio: number): PolyMesh {
  const pos = m.verts.slice();
  let tris: [number, number, number][] = [];
  for (const f of m.faces) for (let i = 1; i + 1 < f.length; i++) tris.push([f[0]!, f[i]!, f[i + 1]!]);
  const target = Math.max(4, Math.floor(tris.length * ratio + 0.5));
  for (let pass = 0; pass < 100 && tris.length > target; pass++) {
    const edgeCount = new Map<string, number>();
    const nb = new Map<number, Set<number>>();
    const vt = new Map<number, number[]>(); // 점 → 삼각형 번호
    const edges: { a: number; b: number; l: number }[] = [];
    tris.forEach((t, ti) => {
      for (let k = 0; k < 3; k++) {
        const a = t[k]!;
        const b = t[(k + 1) % 3]!;
        const key = ekey(a, b);
        const c = edgeCount.get(key) ?? 0;
        edgeCount.set(key, c + 1);
        if (!c) {
          const [lo, hi] = a < b ? [a, b] : [b, a];
          const d = sub(pos[lo]!, pos[hi]!);
          edges.push({ a: lo, b: hi, l: dot(d, d) });
        }
        for (const [x, y] of [[a, b], [b, a]] as const) {
          if (!nb.has(x)) nb.set(x, new Set());
          nb.get(x)!.add(y);
        }
        if (!vt.has(a)) vt.set(a, []);
        vt.get(a)!.push(ti);
      }
    });
    const boundary = new Set<number>();
    for (const [key, c] of edgeCount)
      if (c !== 2) for (const v of key.split(',')) boundary.add(Number(v));
    edges.sort((x, y) => x.l - y.l || x.a - y.a || x.b - y.b);
    const locked = new Set<number>();
    const dead = new Set<number>();
    let alive = tris.length;
    for (const { a, b } of edges) {
      if (alive <= target) break;
      if (locked.has(a) || locked.has(b) || boundary.has(a) || boundary.has(b)) continue;
      const na = nb.get(a)!;
      const nbB = nb.get(b)!;
      let common = 0;
      for (const v of na) if (nbB.has(v)) common++;
      if (common !== 2) continue;
      const mid = rv(mul(add(pos[a]!, pos[b]!), 0.5));
      // 뒤집힘 검사: a 나 b 하나만 가진 삼각형의 법선이 반대가 되면 건너뜀
      let flips = false;
      for (const ti of [...vt.get(a)!, ...vt.get(b)!]) {
        const t = tris[ti]!;
        if (t.includes(a) && t.includes(b)) continue;
        const p = t.map((v) => pos[v]!) as [V3, V3, V3];
        const q = t.map((v) => (v === a || v === b ? mid : pos[v]!)) as [V3, V3, V3];
        if (dot(cross(sub(p[1], p[0]), sub(p[2], p[0])), cross(sub(q[1], q[0]), sub(q[2], q[0]))) <= 0) {
          flips = true;
          break;
        }
      }
      if (flips) continue;
      pos[a] = mid;
      for (const ti of vt.get(b)!) {
        const t = tris[ti]!;
        if (t.includes(a)) dead.add(ti);
        else tris[ti] = t.map((v) => (v === b ? a : v)) as [number, number, number];
      }
      alive -= 2;
      for (const v of [a, b, ...na, ...nbB]) locked.add(v);
    }
    if (!dead.size) break;
    tris = tris.filter((_, ti) => !dead.has(ti));
  }
  const used = [...new Set(tris.flat())].sort((x, y) => x - y);
  const map = new Map(used.map((v, i) => [v, i]));
  return { verts: used.map((v) => pos[v]!), faces: tris.map((t) => t.map((v) => map.get(v)!)) };
}

export function applyModifier(m: PolyMesh, mod: Modifier): PolyMesh {
  switch (mod.type) {
    case 'subsurf': {
      let out = m;
      for (let i = 0; i < mod.levels; i++) out = catmullClark(out);
      return out;
    }
    case 'mirror':
      return mirrorMesh(m, mod.axis, mod.merge);
    case 'array':
      return arrayMesh(m, mod.count, mod.offset);
    case 'solidify':
      return solidifyMesh(m, mod.thickness);
    case 'smooth':
      return smoothMesh(m, mod.factor, mod.repeat);
    case 'decimate':
      return decimateMesh(m, mod.ratio);
  }
}

/** 결과 면 수를 계산 전에 어림 (세분은 면마다 변 수만큼, 이후 4배씩) */
export function estimateFaces(m: PolyMesh, mods: readonly Modifier[]): number {
  let faces = m.faces.length;
  let corners = m.faces.reduce((s, f) => s + f.length, 0);
  for (const mod of mods) {
    if (mod.type === 'subsurf') {
      for (let i = 0; i < mod.levels; i++) {
        faces = corners;
        corners = faces * 4;
      }
    } else if (mod.type === 'mirror') {
      faces *= 2;
      corners *= 2;
    } else if (mod.type === 'array') {
      faces *= mod.count;
      corners *= mod.count;
    } else if (mod.type === 'smooth') {
      // 그대로
    } else if (mod.type === 'decimate') {
      faces = Math.max(4, Math.ceil((corners - 2 * faces) * mod.ratio));
      corners = faces * 3;
    } else {
      faces = faces * 2 + corners;
      corners = corners * 2 + corners * 4;
    }
  }
  return faces;
}

/** 모디파이어 스택 결과 (없으면 원본 그대로) */
export function evaluateModifiers(m: PolyMesh, mods: readonly Modifier[] | undefined): PolyMesh {
  let out = m;
  for (const mod of mods ?? []) out = applyModifier(out, mod);
  return out;
}
