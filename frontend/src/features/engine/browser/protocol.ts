/** 메인 스레드 ↔ 브라우저 CAD 워커 메시지 형식 */
import type { Issue } from '../../../api/backend';
import type { ModelDefinition } from '../../../cad/commandTypes';
import type { DrawingView, DrawingViewName, ExportFormat, Topology } from '../types';

export type WorkerRequest =
  | { id: number; type: 'evaluate'; model: ModelDefinition }
  | { id: number; type: 'export'; model: ModelDefinition; format: ExportFormat }
  | { id: number; type: 'interference'; model: ModelDefinition }
  | { id: number; type: 'topology'; model: ModelDefinition; objectId: string }
  | { id: number; type: 'drawing'; model: ModelDefinition; views: DrawingViewName[] };

export interface WorkerEvaluation {
  ok: boolean;
  issues: Issue[];
  objectCount: number;
  meshes: { objectId: string; positions: Float32Array; indices: Uint32Array }[];
  computeMs: number;
}

export type WorkerResponse =
  | { id: number; ok: true; type: 'evaluate'; result: WorkerEvaluation }
  | { id: number; ok: true; type: 'export'; bytes: Uint8Array }
  | { id: number; ok: true; type: 'interference'; pairs: { a: string; b: string; volume: number }[] }
  | { id: number; ok: true; type: 'topology'; topology: Topology }
  | { id: number; ok: true; type: 'drawing'; views: DrawingView[] }
  | { id: number; ok: false; error: string };
