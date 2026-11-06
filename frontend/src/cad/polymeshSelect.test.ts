import { describe, expect, it } from 'vitest';
import { boundaryEdgeCount, edges, polyMeshError, polyVolume, primitiveMesh } from './polymesh';
import { bevelEdges, bisectFaces, edgeLoop, faceRing, growSelection, proportionalTransform, proportionalWeights, selectLinked } from './polymeshSelect';
import { arrayMesh } from './polymeshModifiers';

const cube = () => primitiveMesh('cube', { size: 2 });

describe('루프·연결 선택, 넓히기·좁히기', () => {
  it('점 둘레 면 고리: 큐브 모서리 = 면 3개, 열린 평면 가장자리 = null', () => {
    expect(faceRing(cube(), 0)).toHaveLength(3);
    expect(faceRing(primitiveMesh('plane'), 0)).toBeNull();
  });

  it('도넛(모두 사각형)의 한 바퀴 고리 / 격자의 열린 줄', () => {
    const t = primitiveMesh('torus', { radius: 10, minorRadius: 3, segments: 12, rings: 8 });
    const [a, b] = edges(t)[0]!;
    const loop = edgeLoop(t, a, b);
    expect([8, 12]).toContain(loop.length); // 작은 원(8) 또는 큰 원(12) 한 바퀴
    expect(new Set(loop).size).toBe(loop.length);
    const g = primitiveMesh('grid', { size: 4, subdivisions: 4 }); // 5×5 점
    const row = edgeLoop(g, 6, 7); // 두 번째 줄 안쪽 선 → 열린 줄 끝까지
    expect(row.length).toBe(5);
  });

  it('연결 선택은 떨어진 조각을 넘지 않고, 넓히기·좁히기는 이웃 한 겹', () => {
    const two = arrayMesh(cube(), 2, [5, 0, 0]);
    expect(selectLinked(two, [0]).sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    const g = primitiveMesh('grid', { size: 4, subdivisions: 4 });
    const grown = growSelection(g, [12]); // 가운데 점 → 이웃 4개 더
    expect(grown).toHaveLength(5);
    expect(growSelection(g, grown, true)).toEqual([12]);
  });
});

describe('베벨 (Ctrl+B)', () => {
  it('큐브 선 하나: 면 7 · 점 10, 닫힘, 부피 = 8 − w²', () => {
    const r = bevelEdges(cube(), [[4, 5]], 0.5);
    if (typeof r === 'string') throw new Error(r);
    expect(r.mesh.faces).toHaveLength(7);
    expect(r.mesh.verts).toHaveLength(10);
    expect(polyMeshError(r.mesh)).toBeNull();
    expect(boundaryEdgeCount(r.mesh)).toBe(0);
    expect(polyVolume(r.mesh)).toBeCloseTo(8 - 0.25);
    expect(r.sel).toHaveLength(4);
  });

  it('큐브 모든 선: 모서리마다 삼각형으로 메워 닫힘 (면 6 + 12 + 8)', () => {
    const c = cube();
    const r = bevelEdges(c, edges(c), 0.3);
    if (typeof r === 'string') throw new Error(r);
    expect(r.mesh.faces).toHaveLength(26);
    expect(boundaryEdgeCount(r.mesh)).toBe(0);
    expect(polyMeshError(r.mesh)).toBeNull();
    const v = polyVolume(r.mesh);
    expect(v).toBeLessThan(8);
    expect(v).toBeGreaterThan(8 - 12 * 0.045 * 2); // 모서리 프리즘만큼만 줄어든다
  });

  it('윗면 둘레(고리 4선) 베벨 = 닫힘, 열린 가장자리는 거부', () => {
    const c = cube();
    const top = c.faces[1]!; // [4,5,6,7]
    const r = bevelEdges(c, top.map((v, i) => [v, top[(i + 1) % 4]!] as [number, number]), 0.2);
    if (typeof r === 'string') throw new Error(r);
    expect(boundaryEdgeCount(r.mesh)).toBe(0);
    expect(r.mesh.faces).toHaveLength(6 + 4); // 베벨 면 4 (모서리마다 부채 2개 → 메울 구멍 없음)
    expect(polyMeshError(r.mesh)).toBeNull();
    expect(typeof bevelEdges(primitiveMesh('plane'), [[0, 1]], 0.1)).toBe('string');
  });
});

describe('비례 편집', () => {
  it('고른 점 1, 반지름 안은 매끈하게 줄고 밖은 0', () => {
    const g = primitiveMesh('grid', { size: 10, subdivisions: 10 }); // 1mm 간격
    const c = g.verts.findIndex((v) => v[0] === 0 && v[1] === 0);
    const w = proportionalWeights(g, [c], 3);
    expect(w.get(c)).toBe(1);
    const at = (x: number) => w.get(g.verts.findIndex((v) => v[0] === x && v[1] === 0)) ?? 0;
    expect(at(1)).toBeCloseTo(3 * (2 / 3) ** 2 - 2 * (2 / 3) ** 3);
    expect(at(1)).toBeGreaterThan(at(2));
    expect(at(3)).toBe(0);
    const up = proportionalTransform(g, w, [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 2, 1]);
    expect(up.verts[c]![2]).toBe(2);
    expect(up.verts[g.verts.findIndex((v) => v[0] === 1 && v[1] === 0)]![2]).toBeCloseTo(2 * at(1), 5);
  });
});

describe('나이프·이등분', () => {
  it('큐브를 z = 0.5 평면으로 자르면 옆면 4개가 둘로 → 면 10, 닫힘, 부피 그대로', () => {
    const c = cube();
    const r = bisectFaces(c, [], [0, 0, 0.5], [0, 0, 1]);
    expect(r.mesh.faces).toHaveLength(10);
    expect(r.mesh.verts).toHaveLength(12);
    expect(boundaryEdgeCount(r.mesh)).toBe(0);
    expect(polyMeshError(r.mesh)).toBeNull();
    expect(polyVolume(r.mesh)).toBeCloseTo(8);
    expect(r.sel).toHaveLength(4);
  });

  it('고른 면만 자르면 이웃 면에는 점만 끼워져 틈이 없다', () => {
    const c = cube();
    const front = c.faces.findIndex((f) => f.every((v) => c.verts[v]![1] === -1));
    const r = bisectFaces(c, [front], [0, 0, 0], [1, 0, 0]);
    expect(r.mesh.faces).toHaveLength(7);
    expect(boundaryEdgeCount(r.mesh)).toBe(0);
  });
});
