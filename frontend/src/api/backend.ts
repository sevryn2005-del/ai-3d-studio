/** 백엔드 엔드포인트별 타입과 호출 함수. 응답 스키마는 backend/app/api/*.py 와 일치해야 한다. */
import { z } from 'zod';
import type { ModelDefinition } from '../cad/commandTypes';
import { apiGet, apiPost, apiPostBlob } from './client';

export const HealthSchema = z.object({
  status: z.literal('ok'),
  version: z.string(),
  cadEngine: z.string(),
});
export type Health = z.infer<typeof HealthSchema>;

export const IssueSchema = z.object({
  path: z.string(),
  message: z.string(),
  severity: z.enum(['error', 'warning']),
});
export type Issue = z.infer<typeof IssueSchema>;

/** 객체 로컬 좌표계의 삼각형 메시. 버퍼는 base64(little-endian Float32 / Uint32). */
export const RenderMeshSchema = z.object({
  objectId: z.string(),
  positions: z.string(),
  indices: z.string(),
  vertexCount: z.number().int().nonnegative(),
  triangleCount: z.number().int().nonnegative(),
});
export type RenderMesh = z.infer<typeof RenderMeshSchema>;

export const ModelEvaluationSchema = z.object({
  ok: z.boolean(),
  issues: z.array(IssueSchema),
  objectCount: z.number(),
  meshes: z.array(RenderMeshSchema),
  computeMs: z.number().nullable(),
});
export type ModelEvaluation = z.infer<typeof ModelEvaluationSchema>;

export const getHealth = (signal?: AbortSignal) => apiGet('/health', HealthSchema, signal);

export const evaluateModel = (model: ModelDefinition, signal?: AbortSignal) =>
  apiPost('/model/evaluate', model, ModelEvaluationSchema, signal);

export const InterferenceSchema = z.object({
  ok: z.boolean(),
  issues: z.array(IssueSchema),
  pairs: z.array(z.object({ a: z.string(), b: z.string(), volume: z.number() })),
});
/** 간섭 검사 (조립품): 서로 파고드는 최상위 객체 쌍 */
export const interferenceModel = (model: ModelDefinition, signal?: AbortSignal) =>
  apiPost('/model/interference', model, InterferenceSchema, signal, 70_000);

import type { ExportFormat } from '../features/engine/types';

/** 모든 최상위 객체를 월드 좌표로 배치한 파일. 로컬 CAD 서버에서 생성된다. */
export const exportModel = (format: ExportFormat, model: ModelDefinition, signal?: AbortSignal) =>
  apiPostBlob(`/export/${format}`, model, signal);
