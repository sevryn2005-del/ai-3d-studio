import { beforeEach, describe, expect, it } from 'vitest';
import { selectCanUndo, selectModel, selectSelectedObject, useSceneStore } from './sceneStore';

function selectedBoxHeight() {
  const o = selectSelectedObject(useSceneStore.getState());
  return o?.kind === 'box' ? o.params.height : undefined;
}

describe('sceneStore', () => {
  beforeEach(() => useSceneStore.getState().reset());

  it('실패한 명령은 모델과 히스토리를 바꾸지 않고 에러만 기록한다', () => {
    const before = selectModel(useSceneStore.getState());
    useSceneStore.getState().dispatch({ type: 'set_params', target: 'box_1', params: { height: -1 } });
    const s = useSceneStore.getState();
    expect(selectModel(s)).toBe(before);
    expect(selectCanUndo(s)).toBe(false);
    expect(s.lastError).toMatch(/치수/);
  });

  it('dispatch → undo → redo', () => {
    const { dispatch, select } = useSceneStore.getState();
    select('box_1');
    dispatch({ type: 'set_params', target: 'box_1', params: { height: 50 } });
    expect(selectedBoxHeight()).toBe(50);
    useSceneStore.getState().undo();
    expect(selectedBoxHeight()).toBe(20);
    useSceneStore.getState().redo();
    expect(selectedBoxHeight()).toBe(50);
  });

  it('선택된 객체를 삭제하면 선택이 해제되고, undo 하면 객체가 돌아온다', () => {
    useSceneStore.getState().select('box_1');
    useSceneStore.getState().dispatch({ type: 'delete_object', target: 'box_1' });
    expect(useSceneStore.getState().selectedId).toBeNull();
    useSceneStore.getState().undo();
    expect(selectModel(useSceneStore.getState()).objects).toHaveLength(1);
  });
});
