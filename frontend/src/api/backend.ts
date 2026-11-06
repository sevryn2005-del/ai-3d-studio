/** 백엔드 엔드포인트별 타입과 호출 함수. 응답 스키마는 backend/app/api/*.py 와 일치해야 한다. */
import { z } from 'zod';
import type { DrawingSection, ModelDefinition } from '../cad/commandTypes';
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
const V3Schema = z.tuple([z.number(), z.number(), z.number()]);
export const TopologySchema = z.object({
  ok: z.boolean(),
  issues: z.array(IssueSchema),
  faces: z.array(z.object({ kind: z.enum(['plane', 'cylinder', 'cone', 'sphere', 'other']), origin: V3Schema, dir: V3Schema, radius: z.number(), positions: z.string(), indices: z.string() })).optional(),
  edges: z.array(z.object({ kind: z.enum(['line', 'circle', 'other']), points: z.string(), mid: V3Schema, center: V3Schema, dir: V3Schema, radius: z.number(), length: z.number() })).optional(),
});
/** 화면 선택용 위상 (형식 v12) */
export const topologyModel = (model: ModelDefinition, id: string, signal?: AbortSignal) =>
  apiPost('/model/topology', { model, id }, TopologySchema, signal, 70_000);

const P2Schema = z.tuple([z.number(), z.number()]);
export const DrawingSchema = z.object({
  ok: z.boolean(),
  issues: z.array(IssueSchema),
  views: z.array(
    z.object({
      name: z.enum(['front', 'top', 'right', 'iso', 'aux1', 'aux2']),
      visible: z.array(z.array(z.number())),
      hidden: z.array(z.array(z.number())),
      circles: z.array(z.object({ center: P2Schema, radius: z.number(), full: z.boolean(), visible: z.boolean() })),
      axes: z.array(z.array(z.number())),
      section: z.array(z.array(z.number())).optional(),
      bounds: z.tuple([z.number(), z.number(), z.number(), z.number()]),
    }),
  ),
});
/** 도면 투상 (숨은선 제거) */
export const drawingModel = (model: ModelDefinition, views: readonly string[], section: DrawingSection | undefined, signal?: AbortSignal, aux?: readonly { toward: number[]; right: number[] }[]) =>
  apiPost('/model/drawing', { model, views, ...(section ? { section } : {}), ...(aux?.length ? { aux } : {}) }, DrawingSchema, signal, 70_000);

/** 간섭 검사 (조립품): 서로 파고드는 최상위 객체 쌍 */
export const interferenceModel = (model: ModelDefinition, signal?: AbortSignal) =>
  apiPost('/model/interference', model, InterferenceSchema, signal, 70_000);

import type { ExportFormat } from '../features/engine/types';

/** 모든 최상위 객체를 월드 좌표로 배치한 파일. 로컬 CAD 서버에서 생성된다. */
export const exportModel = (format: ExportFormat, model: ModelDefinition, signal?: AbortSignal) =>
  apiPostBlob(`/export/${format}`, model, signal);
