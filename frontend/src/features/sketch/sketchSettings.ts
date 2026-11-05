/**
 * 스케치 화면 설정 (사용자 선호, 이 브라우저에만 저장): 종이 배경 · 격자 · 격자 스냅 · 점/정렬 스냅 · 격자 간격.
 * 설계 원본이 아니다. mmPerPx·autoStep 은 화면 확대에 따라 SketchPaper 가 계속 갱신한다.
 */
import { create } from 'zustand';

export type GridStepPref = 'auto' | 0.5 | 1 | 2 | 5 | 10;
export const GRID_STEP_OPTIONS: GridStepPref[] = ['auto', 0.5, 1, 2, 5, 10];

interface Prefs {
  paper: boolean;
  grid: boolean;
  gridSnap: boolean;
  inference: boolean;
  gridStep: GridStepPref;
}

const KEY = 'ai3d.sketchView';
const DEFAULTS: Prefs = { paper: true, grid: true, gridSnap: true, inference: true, gridStep: 'auto' };

function load(): Prefs {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Prefs>;
    return {
      paper: typeof v.paper === 'boolean' ? v.paper : DEFAULTS.paper,
      grid: typeof v.grid === 'boolean' ? v.grid : DEFAULTS.grid,
      gridSnap: typeof v.gridSnap === 'boolean' ? v.gridSnap : DEFAULTS.gridSnap,
      inference: typeof v.inference === 'boolean' ? v.inference : DEFAULTS.inference,
      gridStep: GRID_STEP_OPTIONS.includes(v.gridStep as GridStepPref) ? (v.gridStep as GridStepPref) : DEFAULTS.gridStep,
    };
  } catch {
    return DEFAULTS;
  }
}

interface SketchViewState extends Prefs {
  /** 스케치 평면 위 화면 1픽셀 = 몇 mm */
  mmPerPx: number;
  /** 확대에 맞춘 격자 (잔 칸 · 굵은 칸) */
  auto: { minor: number; major: number };
  set: (p: Partial<Prefs>) => void;
  setScale: (mmPerPx: number, auto: { minor: number; major: number }) => void;
}

export const useSketchView = create<SketchViewState>((set, get) => ({
  ...load(),
  mmPerPx: 0.2,
  auto: { minor: 1, major: 10 },
  set: (p) => {
    set(p);
    const { paper, grid, gridSnap, inference, gridStep } = get();
    try {
      localStorage.setItem(KEY, JSON.stringify({ paper, grid, gridSnap, inference, gridStep }));
    } catch {
      /* 저장소가 막혀 있으면 이번 세션에만 */
    }
  },
  setScale: (mmPerPx, auto) => {
    const s = get();
    if (s.auto.minor === auto.minor && Math.abs(s.mmPerPx - mmPerPx) / mmPerPx < 0.02) return;
    set({ mmPerPx, auto });
  },
}));

/** 지금 보이는 격자 간격 (설정이 'auto' 면 확대에 맞춘 값) */
export function gridSteps(s: Pick<SketchViewState, 'gridStep' | 'auto'>): { minor: number; major: number } {
  if (s.gridStep === 'auto') return s.auto;
  return { minor: s.gridStep, major: s.gridStep * (s.gridStep === 2 ? 5 : 10) };
}

/** 그리기 스냅 간격: 격자 스냅이 켜져 있으면 잔 칸, 꺼져 있으면 0.01mm */
export function drawStep(s: Pick<SketchViewState, 'gridSnap' | 'gridStep' | 'auto'>): number {
  return s.gridSnap ? gridSteps(s).minor : 0.01;
}
