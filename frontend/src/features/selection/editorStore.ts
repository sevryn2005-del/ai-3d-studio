/**
 * 편집기 UI 상태 (설계 원본이 아님 → 히스토리/저장 대상 아님).
 * 기즈모 모드, 스냅 설정, 화면 맞춤 요청 등.
 */
import { create } from 'zustand';
import { DEFAULT_SNAP, type SnapSettings } from '../../cad/transformUtils';

export type TransformMode = 'translate' | 'rotate';
/** 뷰포트 직접 그리기 도구 (null = 선택·이동 모드) */
export type DrawTool = 'rectangle' | 'circle' | 'polygon' | null;

interface EditorState {
  transformMode: TransformMode;
  snapEnabled: boolean;
  /** 값이 바뀔 때마다 뷰포트가 카메라를 모델에 맞춘다 */
  fitRequest: number;
  drawTool: DrawTool;

  setDrawTool: (t: DrawTool) => void;
  setTransformMode: (m: TransformMode) => void;
  toggleSnap: () => void;
  requestFit: () => void;
}

export const useEditorStore = create<EditorState>((set) => ({
  transformMode: 'translate',
  snapEnabled: true,
  fitRequest: 0,
  drawTool: null,

  setDrawTool: (drawTool) => set({ drawTool }),
  setTransformMode: (transformMode) => set({ transformMode }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
}));

const NO_SNAP: SnapSettings = { translation: null, rotation: null };

/** 상수 객체를 반환하므로 Zustand 셀렉터로 써도 불필요한 재렌더가 없다. */
export const selectSnap = (s: EditorState): SnapSettings => (s.snapEnabled ? DEFAULT_SNAP : NO_SNAP);
