/**
 * 브라우저 CAD 엔진 (CadEngine 구현). 서버 없이 웹에서 동작한다.
 * 워커는 처음 사용할 때 만든다. 작업이 제한 시간을 넘기면 워커를 종료하고 다음 요청 때 새로 만든다
 * (서버 WorkerPool 과 같은 격리 원칙).
 */
import type { ModelDefinition } from '../../../cad/commandTypes';
import { validateMesh } from '../../backend/renderMesh';
import { EngineError, type CadEngine, type EngineEvaluation, type ExportFormat } from '../types';
import type { WorkerRequest, WorkerResponse } from './protocol';

export const BROWSER_JOB_TIMEOUT_MS = 20_000;

const MEDIA_TYPES = { stl: 'model/stl', '3mf': 'model/3mf', glb: 'model/gltf-binary', step: 'model/step' } as const;

/** 유니온의 각 멤버에서 id 를 뺀다 (Omit 은 유니온을 하나로 합쳐버린다) */
type WithoutId<T> = T extends unknown ? Omit<T, 'id'> : never;

type Pending = { resolve: (r: WorkerResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> };

export function createBrowserEngine(
  makeWorker: () => Worker = () => new Worker(new URL('./worker.ts', import.meta.url), { type: 'module' }),
  timeoutMs = BROWSER_JOB_TIMEOUT_MS,
): CadEngine {
  let worker: Worker | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();

  const reset = (reason: string) => {
    worker?.terminate();
    worker = null;
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.reject(new EngineError(reason));
    }
    pending.clear();
  };

  const getWorker = () => {
    if (worker) return worker;
    worker = makeWorker();
    worker.onmessage = (e: MessageEvent<WorkerResponse>) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      clearTimeout(p.timer);
      pending.delete(e.data.id);
      p.resolve(e.data);
    };
    worker.onerror = () => reset('브라우저 CAD 엔진을 시작하지 못했습니다');
    return worker;
  };

  const request = (msg: WithoutId<WorkerRequest>, signal?: AbortSignal) =>
    new Promise<WorkerResponse>((resolve, reject) => {
      const id = nextId++;
      const timer = setTimeout(
        () => reset(`형상 계산이 제한 시간(${timeoutMs / 1000}초)을 초과했습니다`),
        timeoutMs,
      );
      pending.set(id, { resolve, reject, timer });
      signal?.addEventListener('abort', () => {
        // 계산 자체는 끝날 때까지 진행되지만 결과는 버린다
        const p = pending.get(id);
        if (!p) return;
        clearTimeout(p.timer);
        pending.delete(id);
        reject(new DOMException('취소됨', 'AbortError'));
      });
      getWorker().postMessage({ ...msg, id } as WorkerRequest);
    });

  return {
    id: 'browser',
    label: '브라우저 엔진',
    exportFormats: ['3mf', 'stl', 'step', 'glb'],

    async evaluate(model: ModelDefinition, signal?: AbortSignal): Promise<EngineEvaluation> {
      const r = await request({ type: 'evaluate', model }, signal);
      if (!r.ok) throw new EngineError(r.error);
      if (r.type !== 'evaluate') throw new EngineError('잘못된 응답입니다');
      return {
        engine: 'browser',
        ...r.result,
        meshes: r.result.meshes.map((m) => validateMesh({ ...m, welded: true })),
      };
    },

    async exportFile(format: ExportFormat, model: ModelDefinition, signal?: AbortSignal): Promise<Blob> {
      const r = await request({ type: 'export', model, format }, signal);
      if (!r.ok) throw new EngineError(r.error);
      if (r.type !== 'export') throw new EngineError('잘못된 응답입니다');
      return new Blob([r.bytes as Uint8Array<ArrayBuffer>], { type: MEDIA_TYPES[format] });
    },
  };
}
