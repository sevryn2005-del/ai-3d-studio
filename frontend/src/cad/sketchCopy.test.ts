import { describe, expect, it } from 'vitest';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { executeBatch } from './commandExecutor';
import { copyEntityCommands, mirrorXform, rotateXform, symmetricRelations, translateXform } from './sketchCopy';
import { withRelations } from './autoRelations';
import { polygonError } from './solver';

function setup(): ModelDefinition {
  const r = executeBatch(emptyModel(), [
    { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
    { type: 'add_rectangle', sketch: 's', id: 'r1', center: [20, 5], width: 10, height: 6 },
    { type: 'add_polygon', sketch: 's', id: 'poly1', points: [[10, 10], [20, 10], [15, 20]] },
    { type: 'set_arc', sketch: 's', entity: 'poly1', edge: 0, bulge: 0.3 },
    { type: 'add_slot', sketch: 's', id: 'slot1', center: [30, 0], length: 8, width: 3, angle: 30 },
    { type: 'add_line', sketch: 's', id: 'ax', points: [[0, -50], [0, 50]] },
    // 축(구성선)은 고정 — 고정하지 않으면 해석기가 축도 움직일 수 있다
    { type: 'add_constraint', sketch: 's', constraint: 'fix', refs: ['ax.p0'] },
    { type: 'add_constraint', sketch: 's', constraint: 'fix', refs: ['ax.p1'] },
  ]);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}
const ids = (m: ModelDefinition) => new Set(m.sketches[0]!.entities.map((e) => e.id));

describe('스케치 대칭·패턴 복사', () => {
  it('세로 축(u = 0) 대칭: 사각형 그대로, 다각형 반시계 유지, 슬롯 각도 반전', () => {
    const m = setup();
    const sk = m.sketches[0]!;
    const { commands } = copyEntityCommands(sk, ['r1', 'poly1', 'slot1'], mirrorXform([0, 0], [0, 1]), ids(m));
    const r = executeBatch(m, commands);
    if (!r.ok) throw new Error(r.error);
    const e = r.model.sketches[0]!.entities;
    expect(e.find((x) => x.id === 'r2')).toMatchObject({ type: 'rectangle', center: [-20, 5] });
    const p = e.find((x) => x.id === 'poly2') as { points: [number, number][]; arcs: { k: number; bulge: number }[] };
    expect(p.points).toEqual([[-15, 20], [-20, 10], [-10, 10]]);
    expect(polygonError(p.points)).toBeNull();
    expect(p.arcs).toEqual([{ k: 1, bulge: 0.3 }]); // 원래 변 0 (10,10)→(20,10) = 새 변 1 (−20,10)→(−10,10)
    expect(e.find((x) => x.id === 'slot2')).toMatchObject({ center: [-30, 0], angle: 150 });
  });

  it('구성선 축 대칭 + 대칭 구속: 원본을 옮기면 복사본이 따라온다', () => {
    const m = setup();
    const sk = m.sketches[0]!;
    const { commands, pairs } = copyEntityCommands(sk, ['poly1'], mirrorXform([0, -50], [0, 50]), ids(m));
    const { commands: all, added } = withRelations(m, commands, 's', symmetricRelations(pairs, 'ax.e0'));
    expect(added).toBe(3);
    const r = executeBatch(m, all);
    if (!r.ok) throw new Error(r.error);
    const moved = executeBatch(r.model, [{ type: 'move_point', sketch: 's', point: 'poly1.p2', to: [15, 25] }]);
    if (!moved.ok) throw new Error(moved.error);
    const p2 = moved.model.sketches[0]!.entities.find((x) => x.id === 'poly2') as { points: number[][] };
    expect(p2.points[0]![1]).toBeCloseTo(25);
  });

  it('직선 패턴·원형 패턴(90° 사각형은 폭·높이 바뀜, 45° 는 다각형)', () => {
    const m = setup();
    const sk = m.sketches[0]!;
    const taken = ids(m);
    const lin = [1, 2].flatMap((k) => copyEntityCommands(sk, ['r1'], translateXform(0, 10 * k), taken).commands);
    expect(lin.map((c) => (c as { center: number[] }).center)).toEqual([[20, 15], [20, 25]]);
    const rot90 = copyEntityCommands(sk, ['r1'], rotateXform([0, 0], 90), taken).commands[0] as { center: number[]; width: number; height: number };
    expect(rot90).toMatchObject({ center: [-5, 20], width: 6, height: 10 });
    expect(copyEntityCommands(sk, ['r1'], rotateXform([0, 0], 45), taken).commands[0]!.type).toBe('add_polygon');
    expect(executeBatch(m, [...lin]).ok).toBe(true);
  });
});
