/** 서버 CAD 엔진: 기존 FastAPI + CadQuery 백엔드를 그대로 사용한다. */
import { evaluateModel, exportModel } from '../../api/backend';
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
};
