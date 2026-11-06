/**
 * 3D 모델링 모드 (블렌더 흐름) 화면 상태 — 설계 원본이 아니다 (저장·실행 취소 대상 아님).
 * 모델 변경은 확정할 때 add_mesh / mesh_edit / set_transform 명령으로만 (sceneStore).
 *
 * - 오브젝트 모드: 객체 선택(sceneStore.selectedId) · G/R/S · Shift+A 추가
 * - 편집 모드 (Tab): 선택 객체의 점·선·면 (1/2/3). 선택은 점 번호 집합으로 저장 (블렌더처럼 선·면 선택은 점에서 유도)
 * - 모달 조작 (G/R/S/E/I): 마우스로 움직이는 동안 preview 만 바뀌고, 클릭·Enter 로 명령 1개 확정, 오른쪽 클릭·Esc 취소
 */
import { create } from 'zustand';
import type { CadCommand, ObjectId, Transform } from '../../cad/commandTypes';
import type { PolyMesh } from '../../cad/polymesh';
import type { Brush } from '../../cad/sculpt';

export type ModelingMode = 'object' | 'edit' | 'sculpt';
export interface SculptSettings {
  brush: Brush;
  /** 화면 픽셀 반지름 (확대해도 화면에서 같은 크기 — 블렌더 기본) */
  radiusPx: number;
  /** 0~1 */
  strength: number;
  symmetryX: boolean;
}
export type SelectMode = 'vert' | 'edge' | 'face';
export type ModalKind = 'grab' | 'rotate' | 'scale' | 'extrude' | 'inset' | 'bevel';
export type Axis = 'x' | 'y' | 'z';

export interface ModalState {
  kind: ModalKind;
  axis: Axis | null;
  /** 키보드로 친 값 (블렌더처럼 "G X 10 Enter") */
  typed: string;
  /** 시작할 때 마우스 위치 (뷰포트 기준 px) */
  start: [number, number];
  /** 모달마다 다른 번호 (계산기가 새 모달을 알아보도록) */
  seq: number;
}

/** 모달 조작 미리보기: 오브젝트 모드는 변환, 편집 모드는 메시 */
export interface ModelingPreview {
  objectId: ObjectId;
  transform?: Transform;
  mesh?: PolyMesh;
  /** 상태 표시줄 문구 (예: "이동 X 12.5mm") */
  label: string;
  /** 확정할 때 보낼 명령과 그 뒤 편집 선택 (예: 돌출 뒤 새 면) */
  command: CadCommand | null;
  afterSel?: number[];
}

interface ModelingState {
  mode: ModelingMode;
  selectMode: SelectMode;
  /** 편집 모드에서 고른 점 번호 (오름차순 아님 — 고른 순서, F 면 채우기에 쓰인다) */
  selVerts: number[];
  modal: ModalState | null;
  preview: ModelingPreview | null;
  /** Shift+A 추가 메뉴 위치 (뷰포트 기준 px), null = 닫힘 */
  addMenu: [number, number] | null;
  /** 마지막으로 본 마우스 위치 (뷰포트 기준 px) — 키로 시작하는 모달·메뉴의 기준점 */
  mouse: [number, number];
  sculpt: SculptSettings;
  setSculpt: (p: Partial<SculptSettings>) => void;
  /** 비례 편집 (O): 편집 모드 G/R/S 에서 반지름(mm) 안 점도 매끈하게 따라온다 */
  proportional: { enabled: boolean; radius: number };
  /** 스냅 (Shift+Tab, 조작 중 Ctrl 로 잠깐 반대): 단위(1mm·5°·0.1배) 또는 점에 붙기 */
  snap: { enabled: boolean; target: 'increment' | 'vertex' };
  setSnap: (p: Partial<{ enabled: boolean; target: 'increment' | 'vertex' }>) => void;
  /** 조작 중 Ctrl 을 누르고 있는지 */
  ctrl: boolean;
  setCtrl: (c: boolean) => void;
  /** 나이프 (K): 화면에 그은 선 (뷰포트 기준 px) */
  knife: { a: [number, number] | null; b: [number, number] | null } | null;
  setKnife: (k: { a: [number, number] | null; b: [number, number] | null } | null) => void;
  /** 스컬프트 마스크 (화면 상태, 저장 안 함): 점마다 0~1. 점 수가 바뀌면 무효 */
  mask: { objectId: string; values: number[] } | null;
  setMask: (m: { objectId: string; values: number[] } | null) => void;
  setProportional: (p: Partial<{ enabled: boolean; radius: number }>) => void;

  setMode: (m: ModelingMode) => void;
  setSelectMode: (m: SelectMode) => void;
  setSel: (v: number[]) => void;
  startModal: (kind: ModalKind) => void;
  setModal: (m: ModalState | null) => void;
  setPreview: (p: ModelingPreview | null) => void;
  setAddMenu: (p: [number, number] | null) => void;
  setMouse: (p: [number, number]) => void;
  reset: () => void;
}

let modalSeq = 0;

export const useModelingStore = create<ModelingState>((set, get) => ({
  mode: 'object',
  selectMode: 'vert',
  selVerts: [],
  modal: null,
  preview: null,
  addMenu: null,
  mouse: [0, 0],
  sculpt: { brush: 'draw', radiusPx: 50, strength: 0.5, symmetryX: false },
  setSculpt: (p) => set((s) => ({ sculpt: { ...s.sculpt, ...p } })),
  proportional: { enabled: false, radius: 10 },
  mask: null,
  setMask: (mask) => set({ mask }),
  knife: null,
  setKnife: (knife) => set({ knife }),
  snap: { enabled: false, target: 'increment' },
  setSnap: (p) => set((s) => ({ snap: { ...s.snap, ...p } })),
  ctrl: false,
  setCtrl: (ctrl) => set((s) => (s.ctrl === ctrl ? s : { ctrl })),
  setProportional: (p) => set((s) => ({ proportional: { ...s.proportional, ...p } })),

  setMode: (mode) => set({ mode, selVerts: [], modal: null, preview: null, addMenu: null, knife: null }),
  setSelectMode: (selectMode) => set({ selectMode }),
  setSel: (selVerts) => set({ selVerts }),
  startModal: (kind) => set({ modal: { kind, axis: null, typed: '', start: get().mouse, seq: ++modalSeq }, addMenu: null }),
  setModal: (modal) => set(modal ? { modal } : { modal: null, preview: null }),
  setPreview: (preview) => set({ preview }),
  setAddMenu: (addMenu) => set({ addMenu }),
  setMouse: (mouse) => set({ mouse }),
  reset: () => set({ mode: 'object', selectMode: 'vert', selVerts: [], modal: null, preview: null, addMenu: null }),
}));
