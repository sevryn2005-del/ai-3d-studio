/**
 * 편집기 UI 상태 (설계 원본이 아님 → 히스토리/저장 대상 아님).
 * 기즈모 모드, 스냅, 화면 맞춤·표준 보기 요청, 마우스 방식, 기준 평면 선택, 진행 중인 피처(속성 관리자) 등.
 */
import { create } from 'zustand';
import type { ObjectId, StandardPlane } from '../../cad/commandTypes';
import { DEFAULT_SNAP, type SnapSettings } from '../../cad/transformUtils';

export type TransformMode = 'translate' | 'rotate';
/** 뷰포트 직접 그리기 도구 (null = 선택·이동 모드) */
export type DrawTool = 'rectangle' | 'circle' | 'polygon' | null;
/**
 * 마우스 방식
 * - solidworks: 가운데 버튼 드래그 = 회전, Ctrl + 가운데 = 이동, Shift + 가운데 = 확대/축소, 휠 = 확대/축소, 왼쪽 = 선택
 * - simple: 왼쪽 드래그 = 회전, 오른쪽 드래그 = 이동, 휠 = 확대/축소 (트랙패드·가운데 버튼 없는 마우스)
 */
export type MouseScheme = 'solidworks' | 'simple';
/** 표준 보기 (솔리드웍스 단축키 Ctrl+1~7, Ctrl+8 = 선택한 스케치에 수직) */
export type ViewName = 'front' | 'back' | 'left' | 'right' | 'top' | 'bottom' | 'iso' | 'normal';

/** 표시 모드: 음영+모서리(기본) · 음영 · 와이어프레임 · 투명(X-ray) */
export type DisplayMode = 'shadedEdges' | 'shaded' | 'wireframe' | 'xray';
/** 단면 보기: axis 에 수직인 평면(위치 offset)으로 잘라 한쪽만 보여 준다 (flip = 반대쪽) */
export interface SectionView {
  axis: 'x' | 'y' | 'z';
  offset: number;
  flip: boolean;
}
export type Point3 = [number, number, number];

/**
 * 속성 관리자에서 확인(✓)을 기다리는 피처. 확정 전에는 뷰포트에 미리보기만 (설계 원본 그대로).
 */
/** cutTarget: 있으면 만든 형상을 그 바디에서 뺀다 (돌출 컷·회전 컷) */
export type PendingFeature =
  | { kind: 'extrude'; sketch: ObjectId; profile: ObjectId; distance: number; cutTarget?: ObjectId }
  | { kind: 'revolve'; sketch: ObjectId; profile: ObjectId; angle: number; cutTarget?: ObjectId };

interface EditorState {
  transformMode: TransformMode;
  snapEnabled: boolean;
  /** 값이 바뀔 때마다 뷰포트가 카메라를 모델에 맞춘다 */
  fitRequest: number;
  /** 값이 바뀔 때마다 그 방향에서 모델 전체가 보이게 카메라를 옮긴다 */
  viewRequest: { name: ViewName; n: number } | null;
  drawTool: DrawTool;
  mouseScheme: MouseScheme;
  chatOpen: boolean;
  /** 피처 트리에서 고른 기준 평면 (스케치 시작에 쓰임) */
  selectedPlane: StandardPlane['type'] | null;
  /** "스케치" 를 눌렀는데 평면이 없을 때: 뷰포트에 기준 평면을 띄워 고르게 한다 */
  pickingPlane: boolean;
  pending: PendingFeature | null;
  displayMode: DisplayMode;
  section: SectionView | null;
  /** 측정 도구: 켜져 있으면 모델 클릭 = 측정 점 (최근 2개) */
  measuring: boolean;
  measurePoints: Point3[];
  massOpen: boolean;
  screenshotRequest: number;
  loftOpen: boolean;
  setLoftOpen: (on: boolean) => void;
  /** 원근(기본) / 직교 투영 */
  projection: 'perspective' | 'orthographic';
  toggleProjection: () => void;

  setDisplayMode: (m: DisplayMode) => void;
  setSection: (s: SectionView | null) => void;
  toggleMeasure: () => void;
  addMeasurePoint: (p: Point3) => void;
  toggleMass: () => void;
  requestScreenshot: () => void;
  setDrawTool: (t: DrawTool) => void;
  setTransformMode: (m: TransformMode) => void;
  toggleSnap: () => void;
  requestFit: () => void;
  requestView: (name: ViewName) => void;
  setMouseScheme: (m: MouseScheme) => void;
  toggleChat: () => void;
  selectPlane: (p: StandardPlane['type'] | null) => void;
  setPickingPlane: (on: boolean) => void;
  setPending: (p: PendingFeature | null) => void;
}

/** 사용자 선호(마우스 방식·AI 패널)는 이 브라우저에만 저장. 저장소가 막혀 있어도 기본값으로 동작 */
function loadPref<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const v = localStorage.getItem(key);
    return allowed.includes(v as T) ? (v as T) : fallback;
  } catch {
    return fallback;
  }
}
function savePref(key: string, value: string) {
  try {
    localStorage.setItem(key, value);
  } catch {
    /* 비공개 모드 등: 이번 세션에만 적용 */
  }
}

export const useEditorStore = create<EditorState>((set) => ({
  transformMode: 'translate',
  snapEnabled: true,
  fitRequest: 0,
  viewRequest: null,
  drawTool: null,
  mouseScheme: loadPref('ai3d.mouseScheme', ['solidworks', 'simple'] as const, 'solidworks'),
  chatOpen: loadPref('ai3d.chatOpen', ['1', '0'] as const, '1') === '1',
  selectedPlane: null,
  pickingPlane: false,
  pending: null,
  displayMode: loadPref('ai3d.displayMode', ['shadedEdges', 'shaded', 'wireframe', 'xray'] as const, 'shadedEdges'),
  section: null,
  measuring: false,
  measurePoints: [],
  massOpen: false,
  screenshotRequest: 0,
  loftOpen: false,
  setLoftOpen: (loftOpen) => set({ loftOpen }),
  projection: loadPref('ai3d.projection', ['perspective', 'orthographic'] as const, 'perspective'),
  toggleProjection: () =>
    set((s) => {
      const projection = s.projection === 'perspective' ? 'orthographic' : 'perspective';
      savePref('ai3d.projection', projection);
      return { projection };
    }),

  setDisplayMode: (displayMode) => {
    savePref('ai3d.displayMode', displayMode);
    set({ displayMode });
  },
  setSection: (section) => set({ section }),
  toggleMeasure: () => set((s) => ({ measuring: !s.measuring, measurePoints: [] })),
  addMeasurePoint: (p) => set((s) => ({ measurePoints: [...s.measurePoints, p].slice(-2) })),
  toggleMass: () => set((s) => ({ massOpen: !s.massOpen })),
  requestScreenshot: () => set((s) => ({ screenshotRequest: s.screenshotRequest + 1 })),
  setDrawTool: (drawTool) => set({ drawTool }),
  setTransformMode: (transformMode) => set({ transformMode }),
  toggleSnap: () => set((s) => ({ snapEnabled: !s.snapEnabled })),
  requestFit: () => set((s) => ({ fitRequest: s.fitRequest + 1 })),
  requestView: (name) => set((s) => ({ viewRequest: { name, n: (s.viewRequest?.n ?? 0) + 1 } })),
  setMouseScheme: (mouseScheme) => {
    savePref('ai3d.mouseScheme', mouseScheme);
    set({ mouseScheme });
  },
  toggleChat: () =>
    set((s) => {
      savePref('ai3d.chatOpen', s.chatOpen ? '0' : '1');
      return { chatOpen: !s.chatOpen };
    }),
  selectPlane: (selectedPlane) => set({ selectedPlane }),
  setPickingPlane: (pickingPlane) => set({ pickingPlane }),
  setPending: (pending) => set({ pending }),
}));

const NO_SNAP: SnapSettings = { translation: null, rotation: null };

/** 상수 객체를 반환하므로 Zustand 셀렉터로 써도 불필요한 재렌더가 없다. */
export const selectSnap = (s: EditorState): SnapSettings => (s.snapEnabled ? DEFAULT_SNAP : NO_SNAP);
