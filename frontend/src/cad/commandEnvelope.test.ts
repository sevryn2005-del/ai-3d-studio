import { beforeEach, describe, expect, it } from 'vitest';
import { newCommandId } from './commandEnvelope';
import { selectModel, selectRevision, useSceneStore } from './sceneStore';

const move = (x: number) => ({ type: 'set_transform', target: 'box_1', position: [x, 0, 0] });
const s = () => useSceneStore.getState();
const snapshot = () => ({ history: s().history, model: selectModel(s()) });

describe('submit (명령 봉투)', () => {
  beforeEach(() => s().reset());

  it('적용: 이력 1건, 새 리비전, 명령 ID 기록', () => {
    expect(selectRevision(s())).toBe(0);
    const r = s().submit({ commandId: 'c1', baseRevision: 0, command: move(10) });
    expect(r).toEqual({ status: 'applied', revision: 1, affectedId: 'box_1' });
    expect(s().history.past).toHaveLength(1);
    expect(s().history.present).toMatchObject({ revision: 1, commandId: 'c1' });
    expect(selectModel(s()).objects[0]!.transform.position).toEqual([10, 0, 0]);
  });

  it('같은 명령 ID 재시도 → 중복으로 무시 (원본·이력 그대로)', () => {
    s().submit({ commandId: 'c1', baseRevision: 0, command: move(10) });
    const before = snapshot();
    // 재시도는 같은 봉투 그대로 (기준 리비전도 같음) → 오래됨이 아니라 중복으로 판정되어야 한다
    expect(s().submit({ commandId: 'c1', baseRevision: 0, command: move(10) })).toEqual({ status: 'duplicate', revision: 1 });
    expect(snapshot()).toEqual(before);
    expect(s().history).toBe(before.history);
  });

  it('실행 취소 후에도 같은 명령 ID 는 다시 적용되지 않는다', () => {
    s().submit({ commandId: 'c1', baseRevision: 0, command: move(10) });
    s().undo();
    expect(selectRevision(s())).toBe(0);
    expect(s().submit({ commandId: 'c1', baseRevision: 0, command: move(10) }).status).toBe('duplicate');
    expect(selectModel(s()).objects[0]!.transform.position).toEqual([0, 0, 0]);
  });

  it('오래된 리비전 → 거부, 원본·이력 보존', () => {
    s().submit({ commandId: 'c1', baseRevision: 0, command: move(10) });
    const before = snapshot();
    const r = s().submit({ commandId: 'c2', baseRevision: 0, command: move(99) });
    expect(r).toMatchObject({ status: 'stale', baseRevision: 0, currentRevision: 1 });
    expect(s().history).toBe(before.history);
    expect(s().lastError).toContain('다른 변경이 먼저');
  });

  it('잘못된 대상 → 거부, 원본·이력 보존, 거부된 ID 는 기록하지 않음', () => {
    const before = snapshot();
    const r = s().submit({ commandId: 'c3', baseRevision: 0, command: { ...move(1), target: 'ghost' } });
    expect(r).toEqual({ status: 'rejected', error: '존재하지 않는 객체입니다: ghost' });
    expect(s().history).toBe(before.history);
    expect(s().history.appliedCommandIds).toEqual([]);
  });

  it.each([
    [{ baseRevision: 0, command: move(1) }],
    [{ commandId: '', baseRevision: 0, command: move(1) }],
    [{ commandId: 'x', baseRevision: -1, command: move(1) }],
    [{ commandId: 'x', baseRevision: 0, command: move(1), extra: true }],
  ])('형식이 잘못된 봉투는 거부: %j', (env) => {
    const before = s().history;
    expect(s().submit(env).status).toBe('rejected');
    expect(s().history).toBe(before);
  });

  it('리비전은 재사용되지 않는다: 실행 취소 후 새 편집은 새 번호', () => {
    s().submit({ commandId: 'a', baseRevision: 0, command: move(1) }); // r1
    s().submit({ commandId: 'b', baseRevision: 1, command: move(2) }); // r2
    s().undo(); // r1
    const r = s().submit({ commandId: 'c', baseRevision: 1, command: move(3) });
    expect(r).toMatchObject({ status: 'applied', revision: 3 });
    // r2 를 보고 만든 봉투는 이제 오래됨 (같은 번호가 다른 상태를 가리키지 않는다)
    expect(s().submit({ commandId: 'd', baseRevision: 2, command: move(4) }).status).toBe('stale');
  });

  it('기존 dispatch 경로도 리비전을 올린다 (봉투 없는 편집과 섞여도 오래됨 판정이 맞다)', () => {
    s().dispatch(move(5));
    expect(selectRevision(s())).toBe(1);
    expect(s().submit({ commandId: 'e', baseRevision: 0, command: move(6) }).status).toBe('stale');
  });
});

describe('newCommandId', () => {
  it('충돌하지 않는 ID', () => {
    const ids = new Set(Array.from({ length: 1000 }, newCommandId));
    expect(ids.size).toBe(1000);
  });
});
