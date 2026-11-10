import { describe, expect, it } from 'vitest';
import { executeBatch } from './commandExecutor';
import { createDefaultModel } from './defaultModel';
import { autoExplode, explodeOffset } from './explode';
import type { ModelDefinition } from './commandTypes';

const run = (m: ModelDefinition, cmds: unknown[]) => {
  const r = executeBatch(m, cmds);
  if (!r.ok) throw new Error(r.error);
  return r.model;
};

describe('분해도 (형식 v41)', () => {
  it('자동 분해: 가운데에서 부품 원점 쪽으로 배율만큼, 가운데에 겹친 부품은 위로', () => {
    const m = run(createDefaultModel(), [
      { type: 'set_transform', target: 'box_1', position: [-20, 0, 0] },
      { type: 'create_box', id: 'b2', width: 10, depth: 10, height: 10, position: [20, 0, 0] },
      { type: 'create_box', id: 'b3', width: 10, depth: 10, height: 10, position: [0, 0, 0] },
    ]);
    expect(autoExplode(m, 1)).toEqual([
      { id: 'box_1', offset: [-20, 0, 0] },
      { id: 'b2', offset: [20, 0, 0] },
      { id: 'b3', offset: [0, 0, 30] },
    ]);
    expect(autoExplode(createDefaultModel())).toEqual([]);
  });
  it('set_explode: 최상위만, 같은 부품 두 번 거부, 0 이동은 빠짐, 빈 목록 = 지우기 — 설계 위치는 그대로', () => {
    const m = run(createDefaultModel(), [{ type: 'create_box', id: 'b2', width: 10, depth: 10, height: 10, position: [30, 0, 0] }]);
    const e = run(m, [{ type: 'set_explode', offsets: [{ id: 'box_1', offset: [0, 0, 0] }, { id: 'b2', offset: [15, 0, 5] }] }]);
    expect(e.explode).toEqual([{ id: 'b2', offset: [15, 0, 5] }]);
    expect(explodeOffset(e, 'b2')).toEqual([15, 0, 5]);
    expect(e.objects).toEqual(m.objects);
    expect(executeBatch(m, [{ type: 'set_explode', offsets: [{ id: 'nope', offset: [1, 0, 0] }] }]).ok).toBe(false);
    expect(executeBatch(m, [{ type: 'set_explode', offsets: [{ id: 'b2', offset: [1, 0, 0] }, { id: 'b2', offset: [2, 0, 0] }] }]).ok).toBe(false);
    expect('explode' in run(e, [{ type: 'set_explode', offsets: [] }])).toBe(false);
  });
});
