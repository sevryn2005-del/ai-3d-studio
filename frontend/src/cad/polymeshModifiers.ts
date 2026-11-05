/**
 * 메시 모디파이어 (형식 v22, 블렌더 모디파이어 스택) — 순수 함수. 원본 메시는 그대로 두고 위에서부터 차례로 적용한 결과를
 * 화면·내보내기·세 엔진이 쓴다. 서버 app/cad/polymesh.py 가 같은 규칙(같은 점·면 순서)으로 계산한다.
 *
 * - subsurf: 캐트멀-클락 세분 (levels 번). 열린 가장자리는 가장자리 규칙(1:6:1)
 * - mirror: 객체 로컬 축 평면(원점)에 대칭 복사. merge 면 평면 위 점을 합치고 평면 위 면(안쪽 면)은 지운다
 * - array: 같은 메시를 offset 만큼씩 count 개 (상대 아님, mm)
 * - solidify: 점 법선 반대쪽으로 thickness 만큼 안쪽 면을 만들고 열린 가장자리는 옆면으로 닫는다
 */
import { centroid, faceNormal, type PolyMesh, type V3 } from './polymesh';

export type Modifier =
  | { type: 'subsurf'; levels: number }
  | { type: 'mirror'; axis: 'x' | 'y' | 'z'; merge: boolean }
  | { type: 'array'; count: number; offset: V3 }
  | { type: 'solidify'; thickness: number };

export const MODIFIER_LABEL: Record<Modifier['type'], string> = {
  subsurf: '세분 표면',
  mirror: '미러',
  array: '배열',
  solidify: '두께',
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
