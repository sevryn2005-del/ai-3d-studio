import { beforeEach, describe, expect, it } from 'vitest';
import { executeBatch } from './commandExecutor';
import { createDefaultModel } from './defaultModel';
import { selectModel, useSceneStore } from './sceneStore';

const HOLE = [
  { type: 'create_cylinder', id: 'hole', radius: 3, height: 22, position: [0, 0, -1] },
  { type: 'cut', id: 'box_holed', base: 'box_1', tools: ['hole'] },
  { type: 'set_params', target: 'hole', params: { radius: 4 } },
];

describe('executeBatch', () => {
  it('순서대로 실행하고 마지막 영향 객체를 돌려준다', () => {
    const r = executeBatch(createDefaultModel(), HOLE);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.commands).toHaveLength(3);
      expect(r.affectedId).toBe('hole');
      expect(r.model.objects.map((o) => o.id)).toEqual(['box_1', 'hole', 'box_holed']);
    }
  });

  it('하나라도 실패하면 전체를 적용하지 않고 몇 번째인지 알려준다', () => {
    const before = createDefaultModel();
    const r = executeBatch(before, [...HOLE, { type: 'delete_object', target: 'hole' }]);
    expect(r).toMatchObject({ ok: false, index: 3 });
    if (!r.ok) expect(r.error).toMatch(/^4번째 명령: /);
    expect(before.objects).toHaveLength(1);
  });
});

describe('sceneStore.dispatchBatch', () => {
  beforeEach(() => useSceneStore.getState().reset());

  it('AI 요청 1건 = 실행 취소 1단계', () => {
    const { dispatchBatch } = useSceneStore.getState();
    dispatchBatch(HOLE, 'ai');
    const s = useSceneStore.getState();
    expect(selectModel(s).objects).toHaveLength(3);
    expect(s.history.present).toMatchObject({ source: 'ai' });
    expect(s.history.present.batch).toHaveLength(3);
    useSceneStore.getState().undo();
    expect(selectModel(useSceneStore.getState()).objects).toHaveLength(1);
    useSceneStore.getState().redo();
    expect(selectModel(useSceneStore.getState()).objects).toHaveLength(3);
  });

  it('실패하면 모델·히스토리 변화 없이 오류만 표시', () => {
    const before = selectModel(useSceneStore.getState());
    useSceneStore.getState().dispatchBatch([{ type: 'set_params', target: 'nope', params: { height: 1 } }], 'ai');
    const s = useSceneStore.getState();
    expect(selectModel(s)).toBe(before);
    expect(s.history.past).toHaveLength(0);
    expect(s.lastError).toContain('1번째 명령');
  });
});
