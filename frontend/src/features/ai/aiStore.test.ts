import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as api from '../../api/ai';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { STALE_RESPONSE, historyForApi, useAiStore } from './aiStore';

const ok = (over: Partial<api.ChatResponse>): api.ChatResponse => ({
  kind: 'message', message: '', commands: [], options: [], issues: [], ...over,
});

describe('useAiStore.send', () => {
  beforeEach(() => {
    useSceneStore.getState().reset();
    useAiStore.setState({ messages: useAiStore.getState().messages.slice(0, 1), pending: null, sentCount: 0 });
  });
  afterEach(() => vi.restoreAllMocks());

  it('"높이를 50mm로" → 명령을 한 단계로 적용하고 변경 요약을 남긴다', async () => {
    const spy = vi.spyOn(api, 'sendChat').mockResolvedValue(
      ok({ kind: 'commands', message: '높이를 50mm로 바꿨습니다.', commands: [{ type: 'set_params', target: 'box_1', params: { height: 50 } }] }),
    );
    useSceneStore.getState().select('box_1');
    await useAiStore.getState().send('높이를 50mm로 바꿔줘');

    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0]![0]).toMatchObject({ selectedId: 'box_1', message: '높이를 50mm로 바꿔줘', history: [] });
    const o = selectModel(useSceneStore.getState()).objects[0]!;
    expect(o.kind === 'box' && o.params.height).toBe(50);
    expect(useAiStore.getState().messages.at(-1)).toMatchObject({ kind: 'commands', changes: ['큐브 높이 50mm'] });

    useSceneStore.getState().undo(); // AI 변경 = 실행 취소 1번
    const back = selectModel(useSceneStore.getState()).objects[0]!;
    expect(back.kind === 'box' && back.params.height).toBe(20);
  });

  it('적용할 수 없는 명령은 모델을 바꾸지 않고 이유를 보여준다', async () => {
    vi.spyOn(api, 'sendChat').mockResolvedValue(ok({ kind: 'commands', message: 'x', commands: [{ type: 'delete_object', target: 'ghost' }] }));
    const before = selectModel(useSceneStore.getState());
    await useAiStore.getState().send('지워줘');
    expect(selectModel(useSceneStore.getState())).toBe(before);
    expect(useAiStore.getState().messages.at(-1)!.text).toContain('적용하지 못했습니다');
  });

  it('요청 중에는 다시 보내지 않는다 (중복 과금 방지)', async () => {
    let resolve!: (r: api.ChatResponse) => void;
    const spy = vi.spyOn(api, 'sendChat').mockReturnValue(new Promise((r) => (resolve = r)));
    const first = useAiStore.getState().send('하나');
    await useAiStore.getState().send('둘');
    resolve(ok({ message: '네' }));
    await first;
    expect(spy).toHaveBeenCalledTimes(1);
    expect(useAiStore.getState().sentCount).toBe(1);
  });

  it.each([
    ['직접 편집', () => useSceneStore.getState().dispatch({ type: 'set_params', target: 'box_1', params: { width: 30 } })],
    ['다른 프로젝트 열기', () => useSceneStore.getState().reset()],
  ])('응답을 기다리는 동안 %s → AI 변경은 적용하지 않고 다시 요청하라고 알린다', async (_, change) => {
    let resolve!: (r: api.ChatResponse) => void;
    vi.spyOn(api, 'sendChat').mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useAiStore.getState().send('높이를 50mm로 바꿔줘');
    change();
    const afterEdit = selectModel(useSceneStore.getState());
    resolve(ok({ kind: 'commands', message: '바꿨습니다', commands: [{ type: 'set_params', target: 'box_1', params: { height: 50 } }] }));
    await pending;
    expect(selectModel(useSceneStore.getState())).toBe(afterEdit);
    expect(useAiStore.getState().messages.at(-1)).toMatchObject({ kind: 'error', text: STALE_RESPONSE });
  });

  it('질문·일반 답변은 모델이 바뀌어도 그대로 보여준다', async () => {
    let resolve!: (r: api.ChatResponse) => void;
    vi.spyOn(api, 'sendChat').mockReturnValue(new Promise((r) => (resolve = r)));
    const pending = useAiStore.getState().send('컵');
    useSceneStore.getState().dispatch({ type: 'translate', target: 'box_1', offset: [1, 0, 0] });
    resolve(ok({ kind: 'question', message: '크기는?', options: ['작게'] }));
    await pending;
    expect(useAiStore.getState().messages.at(-1)).toMatchObject({ kind: 'question' });
  });

  it('빈 메시지는 보내지 않는다', async () => {
    const spy = vi.spyOn(api, 'sendChat');
    await useAiStore.getState().send('   ');
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('historyForApi', () => {
  it('환영·안내 메시지는 빼고, 적용한 변경과 선택지를 텍스트로 포함한다', () => {
    expect(
      historyForApi([
        { id: 0, role: 'assistant', kind: 'welcome', text: '안녕' },
        { id: 1, role: 'user', text: '컵 만들어줘' },
        { id: 2, role: 'assistant', kind: 'question', text: '크기는?', options: ['작게', '크게'] },
        { id: 3, role: 'user', text: '크게' },
        { id: 4, role: 'assistant', kind: 'commands', text: '만들었습니다.', changes: ['원통 추가 지름 80 × 높이 100mm'] },
        { id: 5, role: 'assistant', kind: 'info', text: '요청을 취소했습니다.' },
      ]),
    ).toEqual([
      { role: 'user', text: '컵 만들어줘' },
      { role: 'assistant', text: '크기는?\n[선택지] 작게 / 크게' },
      { role: 'user', text: '크게' },
      { role: 'assistant', text: '만들었습니다.\n[적용한 변경]\n- 원통 추가 지름 80 × 높이 100mm' },
    ]);
  });
});
