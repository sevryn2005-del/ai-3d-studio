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
  /** 화면 선택용 위상 (형식 v12): 객체 하나의 B-rep 면·모서리 (객체 변환 적용 = 부모 좌표계). 계산 실패는 EngineError */
  topology(model: ModelDefinition, objectId: string, signal?: AbortSignal): Promise<Topology>;
  /** 도면 투상 (숨은선 제거): 보이는 최상위 객체를 보기마다 투상한 선. 계산 실패는 EngineError */
  drawing(model: ModelDefinition, views: readonly DrawingViewName[], signal?: AbortSignal): Promise<DrawingView[]>;
}

type V3 = [number, number, number];
/** 면: 평면은 origin = 면 중심, dir = 바깥 법선 / 원통·원뿔은 축(origin, dir)과 반지름 / 구는 중심·반지름 */
export interface TopoFace {
  kind: 'plane' | 'cylinder' | 'cone' | 'sphere' | 'other';
  origin: V3;
  dir: V3;
  radius: number;
  positions: Float32Array;
  indices: Uint32Array;
}
/** 모서리: points = 곡선 위의 점(꺾은선), mid = 매개변수 가운데 점(모서리 위 — 필렛 at 점으로 쓴다) */
export interface TopoEdge {
  kind: 'line' | 'circle' | 'other';
  points: Float32Array;
  mid: V3;
  center: V3;
  dir: V3;
  radius: number;
  length: number;
}
export interface Topology {
  faces: TopoFace[];
  edges: TopoEdge[];
}

export interface InterferencePair {
  a: string;
  b: string;
  volume: number;
}

/** 이보다 작은 겹침 부피(mm³)는 맞닿음(수치 오차)으로 본다 — 서버 jobs.INTERFERENCE_MIN_VOLUME 과 같음 */
export const INTERFERENCE_MIN_VOLUME = 1e-3;

export class EngineError extends Error {}

/**
 * 도면 보기 (features/drawing/views.ts 가 방향 정의 — 서버 app/cad/drawing.py 와 같은 표).
 * 3각법(KS·ISO E): 정면 = −Y 쪽에서, 평면 = 위(+Z)에서, 우측면 = +X 쪽에서, 등각 = (1, −1, 1) 쪽에서 본다.
 */
export type DrawingViewName = 'front' | 'top' | 'right' | 'iso';
/** 투상한 원 (정면으로 보이는 원·원호: 지름 치수용). 보기 평면 좌표 mm */
export interface DrawingCircle {
  center: [number, number];
  radius: number;
  /** 온전한 원 (호가 아니라) */
  full: boolean;
  visible: boolean;
}
/** 보기 하나: 꺾은선 [x0, y0, x1, y1, …] (보기 평면 좌표 mm, x 오른쪽 · y 위). 보이는 선·숨은선 */
export interface DrawingView {
  name: DrawingViewName;
  visible: number[][];
  hidden: number[][];
  circles: DrawingCircle[];
  /** 보이는 선의 범위 [xmin, ymin, xmax, ymax] (선이 없으면 0) */
  bounds: [number, number, number, number];
}
