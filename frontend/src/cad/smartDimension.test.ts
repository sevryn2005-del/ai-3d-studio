import { describe, expect, it } from 'vitest';
import { executeBatch } from './commandExecutor';
import { emptyModel, type Sketch } from './commandTypes';
import { dimensionCommand, hitTarget, planDimension, type DimPlan } from './smartDimension';

function sketchOf(cmds: unknown[]): { model: ReturnType<typeof emptyModel>; sketch: Sketch } {
  const r = executeBatch(emptyModel(), [{ type: 'create_sketch', id: 's' }, ...cmds]);
  if (!r.ok) throw new Error(r.error);
  return { model: r.model, sketch: r.model.sketches[0]! };
}
const base = sketchOf([
  { type: 'add_rectangle', sketch: 's', id: 'r', center: [0, 0], width: 40, height: 20 },
  { type: 'add_circle', sketch: 's', id: 'c', center: [50, 0], diameter: 10 },
  { type: 'add_polygon', sketch: 's', id: 'p', points: [[0, 30], [30, 30], [0, 60]] },
]);
const ok = (p: DimPlan) => {
  if (p.type === 'error') throw new Error(p.message);
  return p;
};

describe('스케치 지능형 치수', () => {
  it('클릭 대상: 점 우선 → 변 → 원', () => {
    const s = base.sketch;
    expect(hitTarget(s, [20.3, 10.2], 1)).toMatchObject({ ref: 'r.p2', kind: 'point' });
    expect(hitTarget(s, [5, -10.4], 1)).toMatchObject({ ref: 'r.e0', kind: 'edge' });
    expect(hitTarget(s, [55.5, 0.5], 1)).toMatchObject({ ref: 'c', kind: 'circle' });
    expect(hitTarget(s, [15, 30.2], 1)).toMatchObject({ ref: 'p.e0', kind: 'edge' });
    expect(hitTarget(s, [100, 100], 1)).toBeNull();
  });
  it('대상에 따라 지름·폭·높이·길이·거리·각도', () => {
    const s = base.sketch;
    const at = (x: number, y: number) => hitTarget(s, [x, y], 1)!;
    expect(ok(planDimension(s, [at(55, 0)]))).toMatchObject({ type: 'dimension', dimension: 'c.diameter', value: 10 });
    expect(ok(planDimension(s, [at(5, -10)]))).toMatchObject({ type: 'dimension', dimension: 'r.width', value: 40 });
    expect(ok(planDimension(s, [at(20, 3)]))).toMatchObject({ type: 'dimension', dimension: 'r.height', value: 20 });
    expect(ok(planDimension(s, [at(15, 30)]))).toMatchObject({ type: 'constraint', constraint: 'length', refs: ['p.e0'], value: 30 });
    expect(ok(planDimension(s, [at(-20, -10), at(30, 30)]))).toMatchObject({ constraint: 'distance', refs: ['r.p0', 'p.p1'], value: 64.031 });
    // p.e0 (오른쪽) → p.e2 ((0,60)→(0,30) 아래쪽): 반시계 270° → 0~180 으로 90°
    expect(ok(planDimension(s, [at(15, 30), at(0, 45)]))).toMatchObject({ constraint: 'angle', value: 90 });
    expect(planDimension(s, [at(5, -10), at(5, 10)])).toMatchObject({ type: 'error' }); // 평행
    expect(planDimension(s, [at(-20, -10), at(15, 30)])).toMatchObject({ type: 'error' }); // 점 + 변
  });
  it('명령으로 적용: 새 구속 추가 → 같은 대상은 값만 고침 → 요소 치수 바꾸기', () => {
    const s = base.sketch;
    const at = (x: number, y: number) => hitTarget(s, [x, y], 1)!;
    const plan = ok(planDimension(s, [at(15, 30)]));
    const r1 = executeBatch(base.model, [dimensionCommand(s, plan, 25)]);
    expect(r1.ok).toBe(true);
    if (!r1.ok) return;
    const s1 = r1.model.sketches[0]!;
    const p1 = s1.entities.find((e) => e.id === 'p')!;
    if (p1.type !== 'polygon') throw new Error();
    expect(Math.hypot(p1.points[1]![0] - p1.points[0]![0], p1.points[1]![1] - p1.points[0]![1])).toBeCloseTo(25, 6);
    const again = ok(planDimension(s1, [hitTarget(s1, [10, 30], 1)!]));
    expect(again).toMatchObject({ existing: s1.constraints[0]!.id });
    expect(dimensionCommand(s1, again, 18)).toEqual({ type: 'set_constraint', sketch: 's', constraint: s1.constraints[0]!.id, value: 18 });
    const r2 = executeBatch(r1.model, [dimensionCommand(s1, ok(planDimension(s1, [hitTarget(s1, [55, 0], 1)!])), 12)]);
    expect(r2.ok && r2.model.sketches[0]!.dimensions.find((d) => d.id === 'c.diameter')!.value).toBe(12);
  });
});
