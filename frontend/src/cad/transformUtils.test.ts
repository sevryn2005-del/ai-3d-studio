import { describe, expect, it } from 'vitest';
import { DEFAULT_SNAP, fitDistance, normalizeAngle, roundTo, transformFromObject3D, transformsEqual } from './transformUtils';

const NO_SNAP = { translation: null, rotation: null };
const rad = (d: number) => (d * Math.PI) / 180;

describe('roundTo', () => {
  it('스텝 단위로 반올림하고 부동소수점 잡음을 없앤다', () => {
    expect(roundTo(12.4, 1)).toBe(12);
    expect(roundTo(0.1 + 0.2, 0.01)).toBe(0.3);
    expect(roundTo(-0.4, 1)).toBe(0);
    expect(Object.is(roundTo(-0.4, 1), -0)).toBe(false);
  });
});

describe('normalizeAngle', () => {
  it.each([
    [0, 0], [180, 180], [-180, 180], [270, -90], [-270, 90], [720, 0],
  ])('%s° → %s°', (input, expected) => expect(normalizeAngle(input)).toBe(expected));
});

describe('transformFromObject3D', () => {
  it('스냅 설정에 따라 위치(1mm)와 회전(15°)을 맞춘다', () => {
    const t = transformFromObject3D({ x: 10.4, y: -3.6, z: 0.2 }, { x: 0, y: 0, z: rad(37) }, DEFAULT_SNAP);
    expect(t).toEqual({ position: [10, -4, 0], rotation: [0, 0, 30] });
  });

  it('스냅이 꺼져도 0.01 정밀도로 정리한다', () => {
    const t = transformFromObject3D({ x: 10.4567, y: 0, z: 0 }, { x: rad(45.0000001), y: 0, z: 0 }, NO_SNAP);
    expect(t).toEqual({ position: [10.46, 0, 0], rotation: [45, 0, 0] });
  });
});

describe('transformsEqual', () => {
  it('미세한 오차는 같은 값으로 본다', () => {
    const a = { position: [1, 2, 3] as [number, number, number], rotation: [0, 0, 0] as [number, number, number] };
    expect(transformsEqual(a, { ...a, position: [1, 2, 3 + 1e-9] })).toBe(true);
    expect(transformsEqual(a, { ...a, position: [1, 2, 4] })).toBe(false);
  });
});

describe('fitDistance', () => {
  it('세로 시야각 기준 거리 계산', () => {
    // fov 90°, aspect 2 → 세로가 더 좁음. sin(45°)=0.7071 → 10/0.7071 ≈ 14.14
    expect(fitDistance(10, 90, 2, 1)).toBeCloseTo(14.142, 2);
  });
  it('세로로 긴 화면에서는 가로 시야각을 기준으로 더 멀어진다', () => {
    expect(fitDistance(10, 90, 0.5, 1)).toBeGreaterThan(fitDistance(10, 90, 2, 1));
  });
});
