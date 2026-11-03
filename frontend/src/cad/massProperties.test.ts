import { describe, expect, it } from 'vitest';
import { BoxGeometry, Matrix4 } from 'three';
import { combine, massGrams, meshProperties } from './massProperties';

describe('질량 특성', () => {
  it('20×10×5 박스: 부피·겉넓이·중심, 월드 이동 반영', () => {
    const g = new BoxGeometry(20, 10, 5);
    const p = meshProperties(g.getAttribute('position').array, g.getIndex()!.array, new Matrix4().makeTranslation(5, 0, 2.5));
    expect(p.volume).toBeCloseTo(1000, 6);
    expect(p.area).toBeCloseTo(2 * (200 + 100 + 50), 6);
    p.centroid.forEach((v, i) => expect(v).toBeCloseTo([5, 0, 2.5][i]!, 6));
    expect(p.min).toEqual([-5, -5, 0]);
  });
  it('합산: 부피 가중 중심, PLA 질량', () => {
    const a = { volume: 1000, area: 1, centroid: [0, 0, 0] as [number, number, number], min: [0, 0, 0] as [number, number, number], max: [1, 1, 1] as [number, number, number] };
    const b = { ...a, volume: 3000, centroid: [4, 0, 0] as [number, number, number] };
    expect(combine([a, b])!.centroid[0]).toBeCloseTo(3);
    expect(massGrams(1000, 1.24)).toBeCloseTo(1.24);
  });
});
