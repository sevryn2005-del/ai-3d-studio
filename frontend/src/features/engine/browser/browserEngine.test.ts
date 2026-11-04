import { describe, expect, it, vi } from 'vitest';
import { createDefaultModel } from '../../../cad/defaultModel';
import { createBrowserEngine } from './browserEngine';
import type { WorkerRequest, WorkerResponse } from './protocol';

/** 응답 방식을 조절할 수 있는 가짜 워커 */
class FakeWorker {
  static created = 0;
  onmessage: ((e: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  terminated = false;
  constructor(private respond: (req: WorkerRequest) => WorkerResponse | null) {
    FakeWorker.created++;
  }
  postMessage(req: WorkerRequest) {
    const res = this.respond(req);
    if (res) setTimeout(() => this.onmessage?.({ data: res } as MessageEvent<WorkerResponse>), 0);
  }
  terminate() {
    this.terminated = true;
  }
}

const evalOk = (req: WorkerRequest): WorkerResponse => ({
  id: req.id, ok: true, type: 'evaluate',
  result: { ok: true, issues: [], objectCount: 1, computeMs: 1,
    meshes: [{ objectId: 'box_1', positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) }] },
});

describe('createBrowserEngine', () => {
  it('워커 결과를 엔진 계약(EngineEvaluation, welded 메시)으로 변환한다', async () => {
    const engine = createBrowserEngine(() => new FakeWorker(evalOk) as unknown as Worker);
    const r = await engine.evaluate(createDefaultModel());
    expect(r).toMatchObject({ engine: 'browser', ok: true, objectCount: 1 });
    expect(r.meshes[0]!.welded).toBe(true);
  });

  it('잘못된 인덱스가 담긴 워커 응답은 거부한다', async () => {
    const bad = (req: WorkerRequest): WorkerResponse => {
      const r = evalOk(req);
      if (r.ok && r.type === 'evaluate') r.result.meshes[0]!.indices = new Uint32Array([0, 1, 9]);
      return r;
    };
    const engine = createBrowserEngine(() => new FakeWorker(bad) as unknown as Worker);
    await expect(engine.evaluate(createDefaultModel())).rejects.toThrow('잘못된 메시 인덱스');
  });

  it('제한 시간을 넘기면 워커를 종료하고 다음 요청은 새 워커로 처리한다', async () => {
    vi.useFakeTimers();
    let hang = true;
    const workers: FakeWorker[] = [];
    const engine = createBrowserEngine(() => {
      const w = new FakeWorker((req) => (hang ? null : evalOk(req)));
      workers.push(w);
      return w as unknown as Worker;
    }, 1000);
    const p = engine.evaluate(createDefaultModel());
    const assertion = expect(p).rejects.toThrow('제한 시간(1초)');
    await vi.advanceTimersByTimeAsync(1001);
    await assertion;
    expect(workers[0]!.terminated).toBe(true);
    hang = false;
    const next = engine.evaluate(createDefaultModel());
    await vi.advanceTimersByTimeAsync(1);
    await expect(next).resolves.toMatchObject({ ok: true });
    expect(workers).toHaveLength(2);
    vi.useRealTimers();
  });

  it('STEP 은 워커(정밀 엔진)에 그대로 요청해 model/step 파일로 받는다', async () => {
    const seen: WorkerRequest[] = [];
    const engine = createBrowserEngine(() => new FakeWorker((req) => {
      seen.push(req);
      return { id: req.id, ok: true, type: 'export', bytes: new TextEncoder().encode('ISO-10303-21;') };
    }) as unknown as Worker);
    expect(engine.exportFormats).toContain('step');
    const blob = await engine.exportFile('step', createDefaultModel());
    expect(blob.type).toBe('model/step');
    expect(seen[0]).toMatchObject({ type: 'export', format: 'step' });
  });
});
