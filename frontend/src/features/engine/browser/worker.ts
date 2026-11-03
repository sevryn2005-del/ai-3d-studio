/// <reference lib="webworker" />
/**
 * 브라우저 CAD 워커: manifold-3d(WASM)로 형상을 계산한다. 메인 스레드(UI)를 막지 않는다.
 * 서버 워커와 같은 원칙: 입력을 다시 검증하고, 등록된 작업(evaluate/export)만 실행한다.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { ModelDefinitionSchema } from '../../../cad/commandTypes';
import { evaluateMeshes, GeometryError, modelIssues, worldMeshes } from './geometry';
import { to3mf, toBinaryStl, toGlb } from './exporters';
import type { WorkerRequest, WorkerResponse } from './protocol';

declare const self: DedicatedWorkerGlobalScope;

let wasm: Promise<ManifoldToplevel> | null = null;
function engine() {
  wasm ??= Module({ locateFile: () => wasmUrl }).then((w) => {
    w.setup();
    return w;
  });
  return wasm;
}

const WRITERS = { stl: toBinaryStl, '3mf': to3mf, glb: toGlb } as const;

self.onmessage = async (e: MessageEvent<WorkerRequest>) => {
  const req = e.data;
  const reply = (msg: WorkerResponse, transfer: Transferable[] = []) => self.postMessage(msg, transfer);
  try {
    const parsed = ModelDefinitionSchema.safeParse(req.model);
    if (!parsed.success) throw new GeometryError('설계 데이터 형식이 올바르지 않습니다');
    const model = parsed.data;
    const graph = modelIssues(model);
    const w = await engine();

    if (req.type === 'evaluate') {
      const started = performance.now();
      if (graph.length) {
        reply({ id: req.id, ok: true, type: 'evaluate', result: {
          ok: false, issues: graph.map((message) => ({ path: '', message, severity: 'error' as const })),
          objectCount: model.objects.length, meshes: [], computeMs: 0 } });
        return;
      }
      try {
        const meshes = evaluateMeshes(w, model);
        reply(
          { id: req.id, ok: true, type: 'evaluate', result: {
            ok: true, issues: [], objectCount: model.objects.length, meshes,
            computeMs: Math.round((performance.now() - started) * 10) / 10 } },
          meshes.flatMap((m) => [m.positions.buffer, m.indices.buffer]),
        );
      } catch (err) {
        if (!(err instanceof GeometryError)) throw err;
        reply({ id: req.id, ok: true, type: 'evaluate', result: {
          ok: false, issues: [{ path: '', message: err.message, severity: 'error' }],
          objectCount: model.objects.length, meshes: [], computeMs: 0 } });
      }
      return;
    }

    if (graph.length) throw new GeometryError(graph[0]!);
    const meshes = worldMeshes(w, model);
    if (meshes.length === 0) throw new GeometryError('내보낼 객체가 없습니다');
    const bytes = WRITERS[req.format](meshes);
    reply({ id: req.id, ok: true, type: 'export', bytes }, [bytes.buffer]);
  } catch (err) {
    if (!(err instanceof GeometryError)) console.error('브라우저 CAD 워커 오류', err);
    reply({ id: req.id, ok: false, error: err instanceof GeometryError ? err.message : '형상 계산 중 내부 오류가 발생했습니다' });
  }
};
