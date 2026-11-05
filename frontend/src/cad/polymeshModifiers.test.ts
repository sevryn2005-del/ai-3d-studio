import { describe, expect, it } from 'vitest';
import { boundaryEdgeCount, deleteElements, polyMeshError, polyVolume, primitiveMesh } from './polymesh';
import { arrayMesh, catmullClark, estimateFaces, evaluateModifiers, mirrorMesh, solidifyMesh } from './polymeshModifiers';

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
