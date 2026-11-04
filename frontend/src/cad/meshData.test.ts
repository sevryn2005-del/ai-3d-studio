import { describe, expect, it } from 'vitest';
import { decodeMesh, encodeMesh, meshError, parseObj, parseStl, prepareImport } from './meshData';

describe('메시 가져오기', () => {
  it('base64 왕복 (리틀엔디안)', () => {
    const m = { positions: Float32Array.from([1.5, -2, 3, 0, 0, 0, 1, 1, 1]), indices: Uint32Array.from([0, 1, 2]) };
    const d = decodeMesh(encodeMesh(m));
    expect([...d.positions]).toEqual([...m.positions]);
    expect([...d.indices]).toEqual([0, 1, 2]);
  });
  it('텍스트 STL·OBJ(사각 면 → 삼각형 2개) 읽기, 원점 규칙으로 옮기기', () => {
    const stl = new TextEncoder().encode('solid t\nfacet normal 0 0 1\nouter loop\nvertex 0 0 5\nvertex 4 0 5\nvertex 0 2 5\nendloop\nendfacet\nendsolid t\n');
    expect([...parseStl(stl.buffer as ArrayBuffer)]).toEqual([0, 0, 5, 4, 0, 5, 0, 2, 5]);
    const obj = parseObj('v 0 0 0\nv 2 0 0\nv 2 2 0\nv 0 2 0\nf 1 2 3 4\n');
    expect(obj.length).toBe(18);
    const r = prepareImport(obj);
    expect(r.triangles).toBe(2);
    expect(r.size).toEqual([2, 2, 0]);
    const d = decodeMesh(r);
    expect(Math.min(...[...d.positions].filter((_, i) => i % 3 === 0))).toBe(-1); // X 가운데 정렬
  });
  it('삼각형 4개 미만·없는 정점은 거부', () => {
    expect(meshError(encodeMesh({ positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: Uint32Array.from([0, 1, 2]) }))).toMatch(/4개/);
    expect(meshError(encodeMesh({ positions: Float32Array.from([0, 0, 0]), indices: Uint32Array.from([0, 1, 2, 0, 1, 2, 0, 1, 2, 0, 1, 2]) }))).toMatch(/없는 정점/);
  });
});
