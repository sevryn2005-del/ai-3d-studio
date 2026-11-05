/**
 * 앱 화면: 시작(홈) ↔ 편집기. 처음 켜면 홈에서 작업 모드(설계 / 3D 모델링)를 고른다.
 * SKIP_HOME_KEY = '1' 이면 예전처럼 바로 편집기(자동 저장본 복원) — 기존 E2E 와 개발용.
 */
import { create } from 'zustand';

export const SKIP_HOME_KEY = 'ai3d.skipHome';

export function skipHome(): boolean {
  try {
    return localStorage.getItem(SKIP_HOME_KEY) === '1';
  } catch {
    return false;
  }
}

interface AppScreenState {
  screen: 'home' | 'editor';
  setScreen: (screen: 'home' | 'editor') => void;
}

export const useAppScreen = create<AppScreenState>((set) => ({
  screen: skipHome() ? 'editor' : 'home',
  setScreen: (screen) => set({ screen }),
}));
