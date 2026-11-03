import { beforeEach, describe, expect, it } from 'vitest';
import { createDefaultModel } from '../../cad/defaultModel';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { useBackendStore } from './backendStore';
import { runEvaluation } from './useBackendSync';
import type { EngineEvaluation } from '../engine/types';

const mesh = { objectId: 'box_1', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]), welded: false };
const result: EngineEvaluation = { engine: 'server', ok: true, issues: [], objectCount: 1, meshes: [mesh], computeMs: 1 };

function deferred<T>() {
  let resolve!: (v: T) => void, reject!: (e: unknown) => void;
  const promise = new Promise<T>((a, b) => ((resolve = a), (reject = b)));
  return { promise, resolve, reject };
}

describe('runEvaluation: 오래되거나 실패한 계산 결과가 설계를 덮어쓰지 않는다', () => {
  beforeEach(() => {
    useSceneStore.getState().reset();
    useBackendStore.setState({ geometries: {}, evaluation: { status: 'idle' } });
  });

  it('계산 중 취소(모델 변경)되면 늦게 온 결과를 버린다', async () => {
    const d = deferred<EngineEvaluation>();
    const controller = new AbortController();
    const run = runEvaluation({ evaluate: () => d.promise }, createDefaultModel(), controller.signal);
    controller.abort(); // 사용자가 그사이 편집
    d.resolve(result);
    expect(await run).toBe('discarded');
    expect(useBackendStore.getState().geometries).toEqual({});
    expect(useBackendStore.getState().evaluation).toEqual({ status: 'idle' });
  });

  it('취소 뒤 실패도 표시하지 않는다', async () => {
    const controller = new AbortController();
    controller.abort();
    expect(await runEvaluation({ evaluate: () => Promise.reject(new Error('x')) }, createDefaultModel(), controller.signal)).toBe('discarded');
    expect(useBackendStore.getState().evaluation).toEqual({ status: 'idle' });
  });

  it('계산 실패는 표시만 하고 설계 원본·이력은 그대로', async () => {
    const before = useSceneStore.getState().history;
    const r = await runEvaluation({ evaluate: () => Promise.reject(new Error('엔진 오류')) }, selectModel(useSceneStore.getState()), new AbortController().signal);
    expect(r).toBe('failed');
    expect(useBackendStore.getState().evaluation).toEqual({ status: 'failed', error: '엔진 오류' });
    expect(useSceneStore.getState().history).toBe(before);
  });

  it('정상 결과는 보낸 모델의 형상 키로만 저장', async () => {
    const before = useSceneStore.getState().history;
    expect(await runEvaluation({ evaluate: async () => result }, createDefaultModel(), new AbortController().signal)).toBe('done');
    expect(Object.keys(useBackendStore.getState().geometries)).toEqual(['box:depth=20,height=20,width=20']);
    expect(useSceneStore.getState().history).toBe(before);
  });
});
