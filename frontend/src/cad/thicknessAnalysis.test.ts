import { describe, expect, it } from 'vitest';
import { BoxGeometry, PlaneGeometry } from 'three';
import { thicknessColor, thicknessGeometry, triangleThickness } from './thicknessAnalysis';

describe('두께 분석', () => {
  it('상자 10×20×30: 면마다 맞은편 벽까지 거리 (X 면 10, Y 면 20, Z 면 30)', () => {
    const g = new BoxGeometry(10, 20, 30).toNonIndexed();
    const th = triangleThickness(g.getAttribute('position').array);
    expect(th).toHaveLength(12);
    // BoxGeometry 면 순서: +x, −x, +y, −y, +z, −z (면마다 삼각형 2개)
    expect([...th].map((v) => Math.round(v * 1e6) / 1e6)).toEqual([10, 10, 10, 10, 20, 20, 20, 20, 30, 30, 30, 30]);
  });
  it('열린 평면은 안쪽에 맞는 면이 없다 (Infinity, 회색)', () => {
    const th = triangleThickness(new PlaneGeometry(10, 10).toNonIndexed().getAttribute('position').array);
    expect([...th].every((v) => v === Infinity)).toBe(true);
    expect(thicknessColor(Infinity, 1)).toEqual([0.6, 0.6, 0.6]);
  });
  it('통계: 한계 15 → X 면(두께 10) 넓이 600 이 얇음, 가장 얇은 곳 10', () => {
    const { stats, geometry } = thicknessGeometry(new BoxGeometry(10, 20, 30), 15);
    expect(stats.min).toBeCloseTo(10);
    expect(stats.thinArea).toBeCloseTo(2 * 20 * 30);
    expect(stats.totalArea).toBeCloseTo(2 * (10 * 20 + 10 * 30 + 20 * 30));
    expect(geometry.getAttribute('color').count).toBe(36);
    expect(thicknessColor(5, 15)).toEqual([0.86, 0.2, 0.18]);
  });
  it('세분된 상자(많은 삼각형)도 BVH 로 같은 값', () => {
    const g = new BoxGeometry(4, 8, 12, 6, 6, 6).toNonIndexed();
    const th = triangleThickness(g.getAttribute('position').array);
    const vals = new Set([...th].map((v) => Math.round(v * 1e4) / 1e4));
    expect([...vals].sort((a, b) => a - b)).toEqual([4, 8, 12]);
  });
});
