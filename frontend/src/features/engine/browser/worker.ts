/// <reference lib="webworker" />
/**
 * 브라우저 CAD 워커: manifold-3d(WASM)로 형상을 계산한다. 메인 스레드(UI)를 막지 않는다.
 * 모서리 필렛·구배·STEP 처럼 정확한 곡면(B-rep)이 필요한 최상위 객체만 OCCT(WASM) 정밀 엔진으로 계산한다
 * (처음 필요할 때 불러옴). STEP 내보내기도 OCCT 가 맡는다.
 * 서버 워커와 같은 원칙: 입력을 다시 검증하고, 등록된 작업(evaluate/export)만 실행한다.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d';
import wasmUrl from 'manifold-3d/manifold.wasm?url';
import { ModelDefinitionSchema, type CadObject, type ModelDefinition } from '../../../cad/commandTypes';
import { byId } from '../../../cad/modelGraph';
import { objectNeedsPrecise } from '../../../cad/features';
import { computedRoots, evaluateMeshes, GeometryError, modelIssues, Scope, worldManifold, worldMeshes } from './geometry';
import { byId as indexOf, sketchIndex } from '../../../cad/modelGraph';
import { INTERFERENCE_MIN_VOLUME } from '../types';
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

/** 정밀 엔진 모듈(코드 + 7MB WASM)은 필요할 때만 불러온다 */
async function precise() {
  const [geo, loader] = await Promise.all([import('../occt/occtGeometry'), import('../occt/loadOcct')]);
  try {
    return { geo, oc: await loader.loadOcct() };
  } catch {
    throw new GeometryError('정밀 엔진(OCCT)을 불러오지 못했습니다');
  }
}

const WRITERS = { stl: toBinaryStl, '3mf': to3mf, glb: toGlb } as const;

/** 최상위 객체를 엔진별로 나눈다 (순서 유지) */
function split(model: ModelDefinition) {
  const index = byId(model);
  const roots = computedRoots(model);
  const isPrecise = (o: CadObject) => objectNeedsPrecise(o, index);
  return { roots, fast: roots.filter((o) => !isPrecise(o)), precise: roots.filter(isPrecise) };
}

type Mesh = { positions: Float32Array; indices: Uint32Array };

async function localMeshes(w: ManifoldToplevel, model: ModelDefinition) {
  const { roots, fast, precise: slow } = split(model);
  const byObj = new Map<string, Mesh>(evaluateMeshes(w, model, undefined, fast).map((m) => [m.objectId, m]));
  if (slow.length) {
    const { geo, oc } = await precise();
    for (const o of slow) byObj.set(o.id, geo.occtLocalMesh(oc, model, o));
  }
  return roots.map((o) => ({ objectId: o.id, ...byObj.get(o.id)! }));
}

async function exportMeshes(w: ManifoldToplevel, model: ModelDefinition) {
  const { roots, fast, precise: slow } = split(model);
  const fastMeshes = worldMeshes(w, model, undefined, fast);
  const byObj = new Map<string, (typeof fastMeshes)[number]>(fast.map((o, i) => [o.id, fastMeshes[i]!]));
  if (slow.length) {
    const { geo, oc } = await precise();
    for (const o of slow) byObj.set(o.id, { name: o.name, ...(o.color ? { color: o.color } : {}), ...(o.material ? { material: o.material } : {}), ...geo.occtWorldMesh(oc, model, o) });
  }
  return roots.map((o) => byObj.get(o.id)!);
}

/**
 * 간섭 검사: 최상위 객체를 월드 좌표 솔리드로 만들어 바운딩 박스가 겹치는 쌍만 교차 부피를 잰다.
 * 정밀 피처가 든 객체는 OCCT 출력 메시를 manifold 솔리드로 바꿔 쓴다 (서버는 CadQuery 교차)
 */
async function interferencePairs(w: ManifoldToplevel, model: ModelDefinition) {
  const { roots, precise: slow } = split(model);
  const scope = new Scope();
  const slowIds = new Set(slow.map((o) => o.id));
  try {
    const index = indexOf(model);
    const sketches = sketchIndex(model);
    let occt: Awaited<ReturnType<typeof precise>> | null = null;
    const solids = [];
    for (const o of roots) {
      if (slowIds.has(o.id)) {
        occt ??= await precise();
        const m = occt.geo.occtWorldMesh(occt.oc, model, o);
        try {
          solids.push({ o, s: scope.keep(new w.Manifold(new w.Mesh({ numProp: 3, vertProperties: m.positions, triVerts: m.indices }))) });
        } catch {
          throw new GeometryError(`'${o.name}': 간섭 검사용 메시를 만들 수 없습니다`);
        }
      } else solids.push({ o, s: worldManifold(w, o, index, 0.05, scope, sketches) });
    }
    const boxes = solids.map(({ s }) => s.boundingBox());
    const pairs: { a: string; b: string; volume: number }[] = [];
    for (let i = 0; i < solids.length; i++)
      for (let j = i + 1; j < solids.length; j++) {
        const [a, b] = [boxes[i]!, boxes[j]!];
        if ([0, 1, 2].some((k) => a.max[k]! <= b.min[k]! || b.max[k]! <= a.min[k]!)) continue;
        const vol = scope.keep(solids[i]!.s.intersect(solids[j]!.s)).volume();
        if (vol > INTERFERENCE_MIN_VOLUME) pairs.push({ a: solids[i]!.o.id, b: solids[j]!.o.id, volume: Math.round(vol * 1e4) / 1e4 });
      }
    return pairs;
  } finally {
    scope.dispose();
  }
}

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
        const meshes = await localMeshes(w, model);
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
    if (req.type === 'topology') {
      // 위상은 항상 정밀 엔진(B-rep)으로 — manifold 메시에는 면·모서리 구분이 없다
      const obj = model.objects.find((o) => o.id === req.objectId);
      if (!obj) throw new GeometryError(`존재하지 않는 객체입니다: ${req.objectId}`);
      const { geo, oc } = await precise();
      const topology = geo.occtTopology(oc, model, obj);
      reply({ id: req.id, ok: true, type: 'topology', topology }, [
        ...topology.faces.flatMap((f) => [f.positions.buffer, f.indices.buffer]),
        ...topology.edges.map((e) => e.points.buffer),
      ]);
      return;
    }
    if (req.type === 'drawing') {
      // 도면도 항상 정밀 엔진 (B-rep 숨은선 제거)
      const [{ occtDrawing }, { oc }] = await Promise.all([import('../occt/occtDrawing'), precise()]);
      reply({ id: req.id, ok: true, type: 'drawing', views: occtDrawing(oc, model, req.views, req.section, req.aux ?? []) });
      return;
    }
    if (req.type === 'interference') {
      reply({ id: req.id, ok: true, type: 'interference', pairs: await interferencePairs(w, model) });
      return;
    }
    let bytes: Uint8Array;
    if (req.format === 'step') {
      const { geo, oc } = await precise();
      bytes = geo.occtStep(oc, model);
    } else {
      const meshes = await exportMeshes(w, model);
      if (meshes.length === 0) throw new GeometryError('내보낼 객체가 없습니다');
      bytes = WRITERS[req.format](meshes);
    }
    reply({ id: req.id, ok: true, type: 'export', bytes }, [bytes.buffer]);
  } catch (err) {
    if (!(err instanceof GeometryError)) console.error('브라우저 CAD 워커 오류', err);
    reply({ id: req.id, ok: false, error: err instanceof GeometryError ? err.message : '형상 계산 중 내부 오류가 발생했습니다' });
  }
};
