/**
 * 삼각형 메시 → 편집 메시 (설계 부품·불리언 결과를 3D 모델링 모드에서 고치기) — 순수 함수.
 * 1) 같은 자리 점 합치기 (0.00001mm) 2) 같은 평면에 붙어 있는 삼각형 묶음의 둘레가 고리 하나면 다각형 면 하나로
 *    (박스 = 사각형 6개, 원기둥 = 옆 사각형 + 뚜껑 n각형). 구멍 난 평면 묶음은 삼각형 그대로.
 */
import { compact, faceNormal, type PolyMesh, type V3 } from './polymesh';

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;

export function weldTriangles(positions: ArrayLike<number>, indices?: ArrayLike<number>, tol = 1e-5): PolyMesh {
  const verts: V3[] = [];
  const map = new Map<string, number>();
  const idOf = (i: number) => {
    const p: V3 = [positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!];
    const k = p.map((v) => Math.round(v / tol)).join(',');
    let id = map.get(k);
    if (id === undefined) {
      id = verts.length;
      map.set(k, id);
      verts.push([r6(p[0]), r6(p[1]), r6(p[2])]);
    }
    return id;
  };
  const n = indices ? indices.length : positions.length / 3;
  const faces: number[][] = [];
  for (let t = 0; t + 2 < n; t += 3) {
    const tri = [0, 1, 2].map((k) => idOf(indices ? indices[t + k]! : t + k));
    if (new Set(tri).size === 3) faces.push(tri);
  }
  return compact({ verts, faces });
}

const ekey = (a: number, b: number) => (a < b ? `${a},${b}` : `${b},${a}`);

export function mergeCoplanar(m: PolyMesh, angleTol = 1e-4, distTol = 1e-4): PolyMesh {
  const normals = m.faces.map((f) => faceNormal(m, f));
  const plane = m.faces.map((f, i) => {
    const n = normals[i]!;
    const p = m.verts[f[0]!]!;
    return n[0] * p[0] + n[1] * p[1] + n[2] * p[2];
  });
  const byEdge = new Map<string, number[]>();
  m.faces.forEach((f, fi) => f.forEach((a, i) => {
    const k = ekey(a, f[(i + 1) % f.length]!);
    byEdge.set(k, [...(byEdge.get(k) ?? []), fi]);
  }));
  const same = (a: number, b: number) => {
    const [na, nb] = [normals[a]!, normals[b]!];
    return 1 - (na[0] * nb[0] + na[1] * nb[1] + na[2] * nb[2]) < angleTol && Math.abs(plane[a]! - plane[b]!) < distTol;
  };
  // 같은 평면 이웃끼리 묶기
  const group = m.faces.map(() => -1);
  let g = 0;
  for (let s = 0; s < m.faces.length; s++) {
    if (group[s] !== -1) continue;
    group[s] = g;
    const stack = [s];
    while (stack.length) {
      const f = stack.pop()!;
      const face = m.faces[f]!;
      face.forEach((a, i) => {
        for (const o of byEdge.get(ekey(a, face[(i + 1) % face.length]!)) ?? []) {
          if (group[o] === -1 && same(s, o)) {
            group[o] = g;
            stack.push(o);
          }
        }
      });
    }
    g++;
  }
  const faces: number[][] = [];
  for (let k = 0; k < g; k++) {
    const members = m.faces.flatMap((f, i) => (group[i] === k ? [f] : []));
    if (members.length === 1) {
      faces.push(members[0]!);
      continue;
    }
    // 둘레 = 묶음 안에서 한 번만 쓰인 방향 선. 고리 하나로 이어지면 다각형 하나
    const count = new Map<string, number>();
    for (const f of members) f.forEach((a, i) => count.set(ekey(a, f[(i + 1) % f.length]!), (count.get(ekey(a, f[(i + 1) % f.length]!)) ?? 0) + 1));
    const next = new Map<number, number>();
    let ok = true;
    for (const f of members)
      f.forEach((a, i) => {
        const b = f[(i + 1) % f.length]!;
        if (count.get(ekey(a, b)) !== 1) return;
        if (next.has(a)) ok = false; // 한 점에서 둘레가 갈라짐
        next.set(a, b);
      });
    const start = next.keys().next().value;
    const loop: number[] = [];
    if (ok && start !== undefined) {
      let c = start;
      for (let guard = 0; guard <= next.size; guard++) {
        loop.push(c);
        c = next.get(c)!;
        if (c === start) break;
      }
    }
    // 고리 하나 + 같은 직선 위 가운데 점(원기둥 이음 등)은 그대로 둔다
    if (ok && loop.length === next.size && loop.length >= 3 && loop.length <= 256) faces.push(loop);
    else faces.push(...members);
  }
  return compact({ verts: m.verts, faces });
}

/** 엔진 삼각형 → 편집 메시 (합치기 + 평면 묶기) */
export function meshFromTriangles(positions: ArrayLike<number>, indices?: ArrayLike<number>): PolyMesh {
  return mergeCoplanar(weldTriangles(positions, indices));
}
