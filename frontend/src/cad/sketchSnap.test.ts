import { describe, expect, it } from 'vitest';
import type { Sketch } from './commandTypes';
import { autoGridStep, sketchSnapPoints, snapSketchPoint } from './sketchSnap';

const sketch = {
  id: 's',
  name: 's',
  plane: { type: 'XY', offset: 0 },
  entities: [
    { id: 'r', type: 'rectangle', center: [10, 0] },
    { id: 'c', type: 'circle', center: [-20, 5] },
    { id: 'l', type: 'line', points: [[0, 20], [10, 30]] },
  ],
  dimensions: [
    { id: 'r.width', entity: 'r', kind: 'width', value: 20 },
    { id: 'r.height', entity: 'r', kind: 'height', value: 10 },
    { id: 'c.diameter', entity: 'c', kind: 'diameter', value: 8 },
  ],
  constraints: [],
} as unknown as Sketch;

const pts = sketchSnapPoints(sketch);
const opt = { tol: 1, grid: 1, inference: true };

describe('스케치 스냅 (끝점·중심·중간점·정렬·격자·각도)', () => {
  it('스냅 점: 원점, 사각형 모서리·변 중간·중심, 원 중심·사분점, 선 끝점·중간점', () => {
    const has = (x: number, y: number, kind: string) => pts.some((p) => p.p[0] === x && p.p[1] === y && p.kind === kind);
    expect(has(0, 0, 'origin')).toBe(true);
    expect(has(20, 5, 'endpoint')).toBe(true);
    expect(has(10, -5, 'midpoint')).toBe(true);
    expect(has(10, 0, 'center')).toBe(true);
    expect(has(-16, 5, 'quadrant')).toBe(true);
    expect(has(5, 25, 'midpoint')).toBe(true);
  });

  it('가까운 점에 정확히 붙는다 (끝점이 중간점보다 먼저)', () => {
    expect(snapSketchPoint([19.6, 5.3], pts, opt)).toMatchObject({ point: [20, 5], kind: 'endpoint' });
    expect(snapSketchPoint([0.4, -0.3], pts, opt)).toMatchObject({ point: [0, 0], kind: 'origin' });
    expect(snapSketchPoint([-19.8, 4.6], pts, opt)).toMatchObject({ point: [-20, 5], kind: 'center' });
  });

  it('점이 없으면 다른 점과 수평·수직 정렬, 나머지 좌표는 격자', () => {
    const r = snapSketchPoint([30.3, 4.8], pts, opt); // v = 5 (사각형 윗변·원 중심과 수평)
    expect(r.point).toEqual([30, 5]);
    expect(r.guides.map((g) => g.dir)).toEqual(['h']);
    const both = snapSketchPoint([-19.7, 29.6], pts, opt); // u = −20 (원 중심 수직), v = 30 (선 끝 수평)
    expect(both.point).toEqual([-20, 30]);
    expect(both.guides.map((g) => g.dir).sort()).toEqual(['h', 'v']);
  });

  it('스냅을 끄면 격자만, 격자도 끄면 그대로', () => {
    expect(snapSketchPoint([19.6, 5.3], pts, { ...opt, inference: false })).toMatchObject({ point: [20, 5], kind: 'grid' });
    expect(snapSketchPoint([19.6, 5.3], pts, { tol: 1, grid: null, inference: false })).toMatchObject({ point: [19.6, 5.3], kind: 'free' });
    expect(snapSketchPoint([12.4, 47.7], pts, { ...opt, grid: 5 }).point).toEqual([10, 50]);
  });

  it('Shift 각도 스냅: 기준점에서 15° 단위, 길이는 격자', () => {
    const r = snapSketchPoint([10.2, 5.4], pts, { ...opt, angleFrom: [0, 0], angleStep: 15 });
    expect(r.angle).toBe(30);
    expect(Math.hypot(...r.point)).toBeCloseTo(12);
  });

  it('확대에 맞춘 격자: 잔 칸 7px 이상, 굵은 칸 10배(2 계열은 5배)', () => {
    expect(autoGridStep(0.1)).toEqual({ minor: 1, major: 10 });
    expect(autoGridStep(0.25)).toEqual({ minor: 2, major: 10 });
    expect(autoGridStep(0.6)).toEqual({ minor: 5, major: 50 });
    expect(autoGridStep(0.01)).toEqual({ minor: 0.1, major: 1 });
  });
});
