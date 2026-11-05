import { describe, expect, it } from 'vitest';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { executeBatch } from './commandExecutor';
import { extendAt, trimAt, trimCommands } from './sketchTrim';

function setup(): ModelDefinition {
  const r = executeBatch(emptyModel(), [
    { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
    { type: 'add_line', sketch: 's', id: 'h', points: [[-20, 0], [20, 0]] },
    { type: 'add_rectangle', sketch: 's', id: 'r1', center: [0, 0], width: 20, height: 10 }, // 세로 변 x = ±10
    { type: 'add_circle', sketch: 's', id: 'c1', center: [30, 0], diameter: 10 }, // x = 25..35
    { type: 'add_path', sketch: 's', id: 'pa', points: [[-5, 20], [5, 20], [5, 30]] },
  ]);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

describe('스케치 잘라내기·연장', () => {
  it('구성선 가운데 조각(사각형 두 변 사이) 잘라내기 → 선 두 개', () => {
    const m = setup();
    const sk = m.sketches[0]!;
    const hit = trimAt(sk, [1, 0.2], 1)!;
    expect(hit.piece).toEqual([[-10, 0], [10, 0]]);
    const r = executeBatch(m, trimCommands(sk, hit));
    if (!r.ok) throw new Error(r.error);
    const lines = r.model.sketches[0]!.entities.filter((e) => e.type === 'line') as { points: number[][] }[];
    expect(lines.map((l) => l.points)).toEqual([[[-20, 0], [-10, 0]], [[10, 0], [20, 0]]]);
  });

  it('끝 조각 잘라내기 → 짧아진 선 하나', () => {
    const m = setup();
    const sk = m.sketches[0]!;
    const hit = trimAt(sk, [15, 0], 1)!;
    expect(hit.piece).toEqual([[10, 0], [20, 0]]);
    const r = executeBatch(m, trimCommands(sk, hit));
    if (!r.ok) throw new Error(r.error);
    expect((r.model.sketches[0]!.entities.find((e) => e.type === 'line') as { points: number[][] }).points).toEqual([[-20, 0], [10, 0]]);
  });

  it('경로 가운데 변 없애기 → 두 조각, 교차 없는 변은 통째로', () => {
    const m = setup();
    const sk = m.sketches[0]!;
    const hit = trimAt(sk, [5.1, 25], 1)!;
    expect(hit).toMatchObject({ entity: 'pa', k: 1, t1: 0, t2: 1 });
    const r = executeBatch(m, trimCommands(sk, hit));
    if (!r.ok) throw new Error(r.error);
    const paths = r.model.sketches[0]!.entities.filter((e) => e.type === 'path') as { points: number[][] }[];
    expect(paths.map((p) => p.points)).toEqual([[[-5, 20], [5, 20]]]);
  });

  it('연장: 선 끝을 원(정확한 식)까지', () => {
    const m = setup();
    const sk = m.sketches[0]!;
    const ext = extendAt(sk, [19.5, 0.3], 1)!;
    expect(ext).toEqual({ point: 'h.p1', from: [20, 0], to: [25, 0] });
    const r = executeBatch(m, [{ type: 'move_point', sketch: 's', point: ext.point, to: ext.to }]);
    expect(r.ok).toBe(true);
    expect(extendAt(sk, [-5, 20], 1)).toBeNull(); // 왼쪽으로는 아무것도 없음
  });
});
