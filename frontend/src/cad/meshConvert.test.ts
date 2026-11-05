import { describe, expect, it } from 'vitest';
import { boundaryEdgeCount, polyMeshError, polyVolume, primitiveMesh, triangulate } from './polymesh';
import { meshFromTriangles, weldTriangles } from './meshConvert';

/** 편집 메시 → 엔진처럼 점을 나눈 삼각형 (삼각형마다 점 3개) */
const soup = (m: ReturnType<typeof primitiveMesh>) => triangulate(m).flatMap((i) => m.verts[i]!);

describe('삼각형 → 편집 메시', () => {
  it('박스: 점 8 · 사각형 6, 닫힘, 부피 그대로', () => {
    const c = primitiveMesh('cube', { size: 20 });
    const m = meshFromTriangles(soup(c));
    expect(m.verts).toHaveLength(8);
    expect(m.faces).toHaveLength(6);
    expect(m.faces.every((f) => f.length === 4)).toBe(true);
    expect(boundaryEdgeCount(m)).toBe(0);
    expect(polyVolume(m)).toBeCloseTo(8000);
  });

  it('원기둥: 옆 사각형 + 뚜껑 n각형', () => {
    const c = primitiveMesh('cylinder', { radius: 5, depth: 10, segments: 16 });
    const m = meshFromTriangles(soup(c));
    expect(m.faces.filter((f) => f.length === 16)).toHaveLength(2);
    expect(m.faces.filter((f) => f.length === 4)).toHaveLength(16);
    expect(polyMeshError(m)).toBeNull();
  });

  it('겹친 점 합치기, 넓이 0 삼각형 버림', () => {
    const w = weldTriangles([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 1, 0, 0.000001]);
    expect(w.verts).toHaveLength(3);
    expect(w.faces).toHaveLength(1);
  });
});
