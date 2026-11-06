import { describe, expect, it } from 'vitest';
import { boundaryEdgeCount, polyMeshError, polyVolume, primitiveMesh } from './polymesh';
import { remeshCellCount, voxelRemesh } from './remesh';
import { arrayMesh } from './polymeshModifiers';
import { selectLinked } from './polymeshSelect';

const ok = (r: ReturnType<typeof voxelRemesh>) => {
  if (typeof r === 'string') throw new Error(r);
  return r;
};

describe('복셀 리메시', () => {
  it('큐브 20mm, 복셀 1: 모두 사각형·닫힘, 크기·부피 거의 그대로', () => {
    const r = ok(voxelRemesh(primitiveMesh('cube', { size: 20 }), 1));
    expect(r.faces.every((f) => f.length === 4)).toBe(true);
    expect(boundaryEdgeCount(r)).toBe(0);
    expect(polyMeshError(r)).toBeNull();
    const xs = r.verts.map((v) => v[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(19);
    expect(Math.max(...xs) - Math.min(...xs)).toBeLessThan(20.5);
    expect(polyVolume(r) / 8000).toBeGreaterThan(0.93); // 모서리가 조금 둥글어진다
    expect(polyVolume(r) / 8000).toBeLessThan(1.02);
  });

  it('구 반지름 10: 점이 고르게 표면 위 (반지름 오차 < 0.3mm), 면 수는 복셀 크기로', () => {
    const sphere = primitiveMesh('uv_sphere', { radius: 10, segments: 32, rings: 16 });
    const r = ok(voxelRemesh(sphere, 1));
    const c = [0, 1, 2].map((a) => r.verts.reduce((s, v) => s + v[a]!, 0) / r.verts.length);
    for (const v of r.verts) expect(Math.abs(Math.hypot(v[0] - c[0]!, v[1] - c[1]!, v[2] - c[2]!) - 10)).toBeLessThan(0.3);
    const coarse = ok(voxelRemesh(sphere, 2.5));
    expect(coarse.faces.length).toBeLessThan(r.faces.length / 4);
  });

  it('겹친 두 큐브 → 한 덩어리로 합쳐짐 (부피 = 합집합)', () => {
    const two = arrayMesh(primitiveMesh('cube', { size: 10 }), 2, [5, 0, 0]);
    const r = ok(voxelRemesh(two, 0.5));
    expect(boundaryEdgeCount(r)).toBe(0);
    expect(selectLinked(r, [0]).length).toBe(r.verts.length);
    expect(polyVolume(r)).toBeGreaterThan(1500 * 0.93);
    expect(polyVolume(r)).toBeLessThan(1500 * 1.03);
  });

  it('복셀이 너무 작으면 거부', () => {
    const big = primitiveMesh('cube', { size: 200 });
    expect(remeshCellCount(big, 0.5)).toBeGreaterThan(2_000_000);
    expect(voxelRemesh(big, 0.5)).toContain('너무 작습니다');
    expect(voxelRemesh(big, 0)).toContain('0 보다');
  });
});
