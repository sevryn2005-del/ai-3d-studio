/**
 * CAD 엔진 인터페이스 (CLAUDE.md 2장).
 *
 * 같은 설계 원본(ModelDefinition)을 같은 규칙으로 해석해 메시와 파일을 만든다.
 * - server : CadQuery/OCCT 백엔드 (Windows·로컬 모드, 또는 클라우드). 정확한 B-rep, STEP 지원.
 * - browser: manifold-3d WASM (Web Worker). 서버 없이 웹에서 동작. 메시 기반.
 *   필렛·구배·STEP 처럼 정확한 곡면이 필요한 객체와 STEP 내보내기는 같은 워커의 OCCT WASM(정밀 엔진)이 맡는다.
 *
 * 메시 계약 (모든 엔진 공통): 최상위 객체마다 하나, 객체 로컬 좌표계(mm), 형상 키 캐시에 저장된다.
 */
import type { Issue } from '../../api/backend';
import type { ModelDefinition } from '../../cad/commandTypes';

export type EngineId = 'server' | 'browser';
export type ExportFormat = 'stl' | '3mf' | 'step' | 'glb';

export interface EngineMesh {
  objectId: string;
  positions: Float32Array; // xyz × 정점
  indices: Uint32Array; // 삼각형 × 3
  /**
   * true: 같은 위치 정점이 면 사이에서 공유됨(브라우저 엔진) → 화면용 법선을 각도 기준으로 분리해야 모서리가 선명하다.
   * false: 면마다 정점이 분리됨(서버 엔진).
   */
  welded: boolean;
}

export interface EngineEvaluation {
  engine: EngineId;
  ok: boolean;
  issues: Issue[];
  objectCount: number;
  meshes: EngineMesh[];
  computeMs: number | null;
}

export interface CadEngine {
  readonly id: EngineId;
  /** 사용자에게 보여줄 이름 */
  readonly label: string;
  readonly exportFormats: readonly ExportFormat[];
  evaluate(model: ModelDefinition, signal?: AbortSignal): Promise<EngineEvaluation>;
  exportFile(format: ExportFormat, model: ModelDefinition, signal?: AbortSignal): Promise<Blob>;
  /** 간섭 검사 (형식 v11): 서로 파고드는 최상위 객체 쌍과 겹친 부피(mm³). 계산 실패는 EngineError */
  interference(model: ModelDefinition, signal?: AbortSignal): Promise<InterferencePair[]>;
}

export interface InterferencePair {
  a: string;
  b: string;
  volume: number;
}

/** 이보다 작은 겹침 부피(mm³)는 맞닿음(수치 오차)으로 본다 — 서버 jobs.INTERFERENCE_MIN_VOLUME 과 같음 */
export const INTERFERENCE_MIN_VOLUME = 1e-3;

export class EngineError extends Error {}
