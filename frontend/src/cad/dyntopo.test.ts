import { describe, expect, it } from 'vitest';
import { boundaryEdgeCount, polyMeshError, polyVolume, primitiveMesh, type V3 } from './polymesh';
import { collapseNear, extendValues, refineNear, remapValues } from './dyntopo';

const len = (a: V3, b: V3) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

describe('다이나믹 토폴로지', () => {
  it('큐브 윗면 가운데: 반경 안 선만 짧아지고, 닫힘·부피 그대로, 먼 면은 그대로', () => {
    const c = primitiveMesh('cube', { size: 20 }); // 가운데 원점, z −10..10
    const r = refineNear(c, [0, 0, 10], 8, 4, 50_000, 6)!;
    expect(r).not.toBeNull();
    expect(r.mesh.verts.length).toBeGreaterThan(c.verts.length + 10);
    expect(r.parents).toHaveLength(r.mesh.verts.length - c.verts.length);
    expect(boundaryEdgeCount(r.mesh)).toBe(0);
    expect(polyMeshError(r.mesh)).toBeNull();
    expect(polyVolume(r.mesh)).toBeCloseTo(8000, 6);
    // 반경 안(선 가운데)의 선은 모두 maxEdge 이하
    for (const f of r.mesh.faces)
      f.forEach((a, k) => {
        const b = f[(k + 1) % f.length]!;
        const A = r.mesh.verts[a]!;
        const B = r.mesh.verts[b]!;
        const mid: V3 = [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, (A[2] + B[2]) / 2];
        if (len(mid, [0, 0, 10]) < 6) expect(len(A, B)).toBeLessThanOrEqual(4 + 1e-9);
      });
    // 바닥면 근처에는 새 점이 없다
    expect(r.mesh.verts.slice(c.verts.length).every((v) => v[2] > 0)).toBe(true);
  });

  it('이미 촘촘하면 그대로 (null), 점 한도를 넘지 않는다', () => {
    const g = primitiveMesh('grid', { size: 4, subdivisions: 4 }); // 선 1mm
    expect(refineNear({ ...g, faces: g.faces.flatMap((f) => [[f[0]!, f[1]!, f[2]!], [f[0]!, f[2]!, f[3]!]]) }, [0, 0, 0], 1, 5)).toBeNull();
    const c = primitiveMesh('cube', { size: 20 });
    const r = refineNear(c, [0, 0, 10], 30, 0.5, c.verts.length + 20)!;
    expect(r.mesh.verts.length).toBeLessThanOrEqual(c.verts.length + 20);
    expect(boundaryEdgeCount(r.mesh)).toBe(0);
  });

  it('점별 값 이어 붙이기 = 부모 평균', () => {
    expect(extendValues([0, 1, 0.5], [[0, 1], [1, 3]])).toEqual([0, 1, 0.5, 0.5, 0.75]);
  });
});

describe('짧은 선 합치기', () => {
  it('촘촘하게 쪼갠 큐브 윗면을 다시 합치면: 점이 줄고, 닫힘·오류 없음·부피 그대로', () => {
    const c = primitiveMesh('cube', { size: 20 });
    const fine = refineNear(c, [0, 0, 10], 9, 1.2, 50_000, 8)!.mesh;
    const r = collapseNear(fine, [0, 0, 10], 6, 2.5, 4)!;
    expect(r).not.toBeNull();
    expect(r.mesh.verts.length).toBeLessThan(fine.verts.length);
    expect(boundaryEdgeCount(r.mesh)).toBe(0);
    expect(polyMeshError(r.mesh)).toBeNull();
    expect(polyVolume(r.mesh)).toBeCloseTo(8000, 3); // 평평한 윗면 안에서만 합쳐진다
    // 점 번호 옮기기: 모든 원래 점이 새 점에 대응 (합쳐진 점 포함)
    expect([...r.remap].every((j) => j >= 0 && j < r.mesh.verts.length)).toBe(true);
    const vals = remapValues(fine.verts.map(() => 1), r.remap, r.mesh.verts.length);
    expect(vals.every((v) => v === 1)).toBe(true);
  });

  it('짧은 선이 없으면 null, 다각형(사각형) 면 둘레는 건드리지 않는다', () => {
    expect(collapseNear(primitiveMesh('cube', { size: 20 }), [0, 0, 10], 30, 1)).toBeNull();
    const g = primitiveMesh('grid', { size: 4, subdivisions: 4 }); // 사각형 면
    expect(collapseNear(g, [0, 0, 0], 3, 5)).toBeNull();
  });
});
