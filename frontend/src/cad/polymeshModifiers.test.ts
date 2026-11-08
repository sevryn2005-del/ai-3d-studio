import { describe, expect, it } from 'vitest';
import { boundaryEdgeCount, deleteElements, polyMeshError, polyVolume, primitiveMesh } from './polymesh';
import { arrayMesh, catmullClark, decimateMesh, estimateFaces, evaluateModifiers, mirrorMesh, smoothMesh, solidifyMesh } from './polymeshModifiers';

const cube = () => primitiveMesh('cube', { size: 2 });

describe('메시 모디파이어', () => {
  it('세분 표면: 큐브 1단계 = 점 26 · 면 24, 닫힘, 부피는 줄어든다', () => {
    const c = catmullClark(cube());
    expect(c.verts).toHaveLength(26);
    expect(c.faces).toHaveLength(24);
    expect(polyMeshError(c)).toBeNull();
    expect(boundaryEdgeCount(c)).toBe(0);
    const v1 = polyVolume(c);
    expect(v1).toBeCloseTo(3.333336, 5); // 모서리 점 → (5/9, 5/9, 5/9)
    expect(v1).toBeLessThan(8);
    const c2 = evaluateModifiers(cube(), [{ type: 'subsurf', levels: 2 }]);
    expect(c2.faces).toHaveLength(96);
    expect(polyVolume(c2)).toBeLessThan(v1); // 극한 곡면(구 비슷)에 가까워진다
    expect(estimateFaces(cube(), [{ type: 'subsurf', levels: 2 }])).toBe(96);
  });

  it('세분 표면: 열린 평면은 가장자리 규칙, 여전히 평평', () => {
    const p = catmullClark(primitiveMesh('plane', { size: 2 }));
    expect(p.faces).toHaveLength(4);
    expect(p.verts.every((v) => v[2] === 0)).toBe(true);
    expect(boundaryEdgeCount(p)).toBe(8);
  });

  it('미러: 반쪽 큐브(x ≥ 0, 평면 위 면 삭제) + 합치기 = 닫힌 큐브', () => {
    const half = { verts: cube().verts.map((v) => [Math.max(0, v[0]), v[1], v[2]] as [number, number, number]), faces: cube().faces };
    // 왼쪽 면(x = 0 에 놓인 면)을 지우고 (열린 반쪽), 미러로 닫는다
    const open = deleteElements(half, half.verts.flatMap((v, i) => (v[0] === 0 ? [i] : [])), 'faces');
    expect(boundaryEdgeCount(open)).toBe(4);
    const m = mirrorMesh(open, 'x', true);
    expect(boundaryEdgeCount(m)).toBe(0);
    expect(polyVolume(m)).toBeCloseTo(8);
    expect(polyMeshError(m)).toBeNull();
  });

  it('배열·두께', () => {
    const a = arrayMesh(cube(), 3, [5, 0, 0]);
    expect(polyVolume(a)).toBeCloseTo(24);
    const s = solidifyMesh(primitiveMesh('plane', { size: 2 }), 0.5);
    expect(boundaryEdgeCount(s)).toBe(0);
    expect(polyVolume(s)).toBeCloseTo(2); // 2 × 2 × 0.5
  });
});

describe('매끈하게 · 면 줄이기 (형식 v31, 서버 polymesh.py 와 같은 규칙)', () => {
  it('매끈하게: 큐브 꼭짓점이 이웃 평균 쪽으로 — 대칭 유지, 부피 줄어듦, 세기 0 은 그대로', () => {
    const c = primitiveMesh('cube', { size: 20 });
    expect(smoothMesh(c, 0, 3).verts).toEqual(c.verts);
    const s = smoothMesh(c, 0.5, 1);
    // 꼭짓점 (±10,±10,±10) 의 이웃 셋 평균 = (±10/3, …) → 반만큼: 10 − (10 − 10/3)/2 = 6.666667
    for (const p of s.verts) for (const x of p) expect(Math.abs(x)).toBeCloseTo(6.666667, 6);
    expect(polyVolume(s)).toBeLessThan(polyVolume(c));
  });
  it('면 줄이기: 닫힌 메시는 닫힌 채로 삼각형 수가 목표 근처, 비율 1 은 삼각형만', () => {
    const sphere = evaluateModifiers(primitiveMesh('cube', { size: 20 }), [{ type: 'subsurf', levels: 3 }]);
    const tris = sphere.faces.length * 2;
    const d = decimateMesh(sphere, 0.25);
    expect(polyMeshError(d)).toBeNull();
    expect(boundaryEdgeCount(d)).toBe(0);
    expect(d.faces.every((f) => f.length === 3)).toBe(true);
    expect(d.faces.length).toBeLessThanOrEqual(Math.round(tris * 0.3));
    expect(d.faces.length).toBeGreaterThanOrEqual(Math.round(tris * 0.25));
    expect(polyVolume(d) / polyVolume(sphere)).toBeGreaterThan(0.9);
    expect(estimateFaces(sphere, [{ type: 'decimate', ratio: 0.25 }])).toBe(Math.ceil(tris * 0.25));
    const full = decimateMesh(sphere, 1);
    expect(full.faces.length).toBe(tris);
    expect(polyVolume(full)).toBeCloseTo(polyVolume(sphere), 6);
  });
  it('면 줄이기: 열린 가장자리는 그대로 (격자 평면의 테두리 점이 남는다)', () => {
    const g = primitiveMesh('grid', { size: 20, subdivisions: 8 });
    const d = decimateMesh(g, 0.3);
    const edge = (p: number[]) => Math.abs(Math.abs(p[0]!) - 10) < 1e-9 || Math.abs(Math.abs(p[1]!) - 10) < 1e-9;
    expect(d.verts.filter(edge).length).toBe(g.verts.filter(edge).length);
    expect(d.faces.length).toBeLessThan(g.faces.length * 2);
  });
});
