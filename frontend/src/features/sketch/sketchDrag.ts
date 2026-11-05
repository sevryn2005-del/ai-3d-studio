import { create } from 'zustand';
import type { Sketch } from '../../cad/commandTypes';

/** 꼭짓점을 끄는 동안 다시 푼 스케치 미리보기 (설계 원본은 놓을 때 move_point 명령 하나로) */
export const useSketchDrag = create<{ preview: Sketch | null; hover: string | null; set: (p: Partial<{ preview: Sketch | null; hover: string | null }>) => void }>((set) => ({
  preview: null,
  hover: null,
  set: (p) => set(p),
}));
