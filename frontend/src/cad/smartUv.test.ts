import { describe, expect, it } from 'vitest';
import { BoxGeometry, CylinderGeometry } from 'three';
import { smartUv } from './smartUv';

const tris = (g: { toNonIndexed(): { getAttribute(n: string): { array: ArrayLike<number> } } }) => g.toNonIndexed().getAttribute('position').array;

/** 차트 상자들이 서로 겹치지 않는지: 삼각형 UV 상자를 차트별로 묶을 수 없으니, 서로 다른 면 법선의 삼각형 UV 중심이 겹치지 않는지 넓이로 확인 */
function uvArea(uv: Float32Array) {
  let s = 0;
  for (let i = 0; i < uv.length; i += 6) s += Math.abs((uv[i + 2]! - uv[i]!) * (uv[i + 5]! - uv[i + 1]!) - (uv[i + 4]! - uv[i]!) * (uv[i + 3]! - uv[i + 1]!)) / 2;
  return s;
}

describe('스마트 UV 펼치기 (형식 v46)', () => {
  it('상자 = 면 6개 차트, 모두 0~1 안, 늘어나지 않음 (UV 넓이 비율 = 실제 넓이 비율)', () => {
    const p = tris(new BoxGeometry(40, 20, 10));
    const r = smartUv(p);
    expect(r.charts).toBe(6);
    expect(Math.min(...r.uv)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...r.uv)).toBeLessThanOrEqual(1);
    // 같은 축척: UV 넓이 합 / 실제 넓이 합 = 1/size² → 각 면의 UV 넓이 비율이 실제 비율과 같다
    const face = (k: number) => uvArea(r.uv.slice(k * 12, k * 12 + 12));
    expect(face(0) / face(4)).toBeCloseTo((20 * 10) / (40 * 20), 6); // +X 면 / +Z 면
    expect(r.fill).toBeGreaterThan(0.4);
  });
  it('차트끼리 겹치지 않는다 (UV 넓이 합 = 차트 넓이 합 ≤ 1), 원통 = 옆면이 각도 한계로 몇 조각 + 위·아래', () => {
    const r = smartUv(tris(new CylinderGeometry(10, 10, 30, 32)));
    expect(r.charts).toBeGreaterThanOrEqual(4);
    expect(r.charts).toBeLessThanOrEqual(12);
    expect(uvArea(r.uv)).toBeLessThan(1);
    expect(Math.max(...r.uv)).toBeLessThanOrEqual(1);
  });
});
