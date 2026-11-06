/** 서버 CAD 엔진: 기존 FastAPI + CadQuery 백엔드를 그대로 사용한다. */
import { drawingModel, evaluateModel, exportModel, interferenceModel, topologyModel } from '../../api/backend';
import { fromBase64 } from '../../cad/meshData';
import { EngineError } from './types';
import { decodeRenderMeshArrays } from '../backend/renderMesh';
import type { CadEngine } from './types';

export const serverEngine: CadEngine = {
  id: 'server',
  label: 'CadQuery (로컬 서버)',
  exportFormats: ['3mf', 'stl', 'step', 'glb'],

  async evaluate(model, signal) {
    const r = await evaluateModel(model, signal);
    return {
      engine: 'server',
      ok: r.ok,
      issues: r.issues,
      objectCount: r.objectCount,
      computeMs: r.computeMs,
      meshes: r.meshes.map(decodeRenderMeshArrays),
    };
  },

  exportFile(format, model, signal) {
    return exportModel(format, model, signal);
  },

  async interference(model, signal) {
    const r = await interferenceModel(model, signal);
    if (!r.ok) throw new EngineError(r.issues[0]?.message ?? '간섭 검사를 할 수 없습니다');
    return r.pairs;
  },

  async drawing(model, views, section, signal, aux) {
    const r = await drawingModel(model, views, section, signal, aux);
    if (!r.ok) throw new EngineError(r.issues[0]?.message ?? '도면을 만들 수 없습니다');
    return r.views;
  },

  async topology(model, id, signal) {
    const r = await topologyModel(model, id, signal);
    if (!r.ok || !r.faces || !r.edges) throw new EngineError(r.issues[0]?.message ?? '면·모서리를 계산할 수 없습니다');
    const f32 = (b: string) => {
      const u = fromBase64(b);
      return new Float32Array(u.buffer, u.byteOffset, u.byteLength / 4).slice();
    };
    const u32 = (b: string) => {
      const u = fromBase64(b);
      return new Uint32Array(u.buffer, u.byteOffset, u.byteLength / 4).slice();
    };
    return {
      faces: r.faces.map((f) => ({ ...f, positions: f32(f.positions), indices: u32(f.indices) })),
      edges: r.edges.map((e) => ({ ...e, points: f32(e.points) })),
    };
  },
};
