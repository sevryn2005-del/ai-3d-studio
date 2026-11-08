import { describe, expect, it } from 'vitest';
import { BoxGeometry } from 'three';
import { draftAngle, draftClass, draftGeometry } from './draftAnalysis';

describe('구배 분석', () => {
  it('구배 각 = asin(법선 · 빼는 방향)', () => {
    expect(draftAngle([0, 0, 1], [0, 0, 1])).toBeCloseTo(90);
    expect(draftAngle([1, 0, 0], [0, 0, 1])).toBeCloseTo(0);
    expect(draftAngle([Math.cos(0.1), 0, Math.sin(0.1)], [0, 0, 1])).toBeCloseTo((0.1 * 180) / Math.PI);
    expect(draftClass(3, 1)).toBe('positive');
    expect(draftClass(-3, 1)).toBe('negative');
    expect(draftClass(0.5, 1)).toBe('insufficient');
  });
  it('상자 (Z 로 뺌): 윗면 양, 아랫면 음, 옆면 넷은 구배 부족 — 넓이로', () => {
    const { geometry, area } = draftGeometry(new BoxGeometry(10, 20, 30), [0, 0, 1], 1);
    expect(area.positive).toBeCloseTo(200);
    expect(area.negative).toBeCloseTo(200);
    expect(area.insufficient).toBeCloseTo(2 * (10 * 30 + 20 * 30));
    expect(geometry.getAttribute('color').count).toBe(36);
  });
});
