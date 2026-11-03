import { describe, expect, it } from 'vitest';
import { canRedo, canUndo, createHistory, HISTORY_LIMIT, pushHistory, redo, undo } from './history';
import { executeCommand } from './commandExecutor';
import { createDefaultModel } from './defaultModel';
import type { CadCommand, ModelDefinition } from './commandTypes';

function apply(model: ModelDefinition, cmd: CadCommand) {
  const r = executeCommand(model, cmd);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

const setHeight = (h: number): CadCommand => ({ type: 'set_params', target: 'box_1', params: { height: h } });
const height = (m: ModelDefinition) => {
  const o = m.objects[0];
  return o?.kind === 'box' ? o.params.height : undefined;
};

describe('history', () => {
  it('undo / redo 로 상태를 오간다', () => {
    const m0 = createDefaultModel();
    let h = createHistory(m0);
    expect(canUndo(h)).toBe(false);

    const m1 = apply(m0, setHeight(50));
    h = pushHistory(h, setHeight(50), m1);
    expect(height(h.present.model)).toBe(50);

    h = undo(h);
    expect(height(h.present.model)).toBe(20);
    expect(canRedo(h)).toBe(true);

    h = redo(h);
    expect(height(h.present.model)).toBe(50);
  });

  it('새 명령은 redo 스택을 비운다', () => {
    const m0 = createDefaultModel();
    let h = pushHistory(createHistory(m0), setHeight(50), apply(m0, setHeight(50)));
    h = undo(h);
    h = pushHistory(h, setHeight(30), apply(h.present.model, setHeight(30)));
    expect(canRedo(h)).toBe(false);
    expect(height(h.present.model)).toBe(30);
  });

  it('빈 스택에서 undo/redo 는 아무 것도 하지 않는다', () => {
    const h = createHistory(createDefaultModel());
    expect(undo(h)).toBe(h);
    expect(redo(h)).toBe(h);
  });

  it(`최대 ${HISTORY_LIMIT}단계까지만 보관한다`, () => {
    const m0 = createDefaultModel();
    let h = createHistory(m0);
    for (let i = 1; i <= HISTORY_LIMIT + 50; i++) {
      h = pushHistory(h, setHeight(i), apply(m0, setHeight(i)));
    }
    expect(h.past).toHaveLength(HISTORY_LIMIT);
  });
});
