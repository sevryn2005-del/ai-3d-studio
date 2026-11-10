import { create } from 'zustand';
import type { RenderOptions } from './renderImage';

/** 렌더 패널 ↔ 캔버스 안 RenderTaker: 요청(n 증가)과 결과(그림 주소) */
interface RenderState {
  open: boolean;
  setOpen: (open: boolean) => void;
  request: { n: number; options: RenderOptions } | null;
  start: (options: RenderOptions) => void;
  busy: boolean;
  result: { url: string; width: number; height: number; ms: number } | null;
  error: string | null;
  finish: (r: { blob: Blob; width: number; height: number; ms: number } | { error: string }) => void;
}

export const useRenderStore = create<RenderState>((set, get) => ({
  open: false,
  setOpen: (open) => set({ open }),
  request: null,
  start: (options) => set((s) => ({ request: { n: (s.request?.n ?? 0) + 1, options }, busy: true, error: null })),
  busy: false,
  result: null,
  error: null,
  finish: (r) => {
    const old = get().result;
    if (old) URL.revokeObjectURL(old.url);
    if ('error' in r) set({ busy: false, error: r.error, result: null });
    else set({ busy: false, error: null, result: { url: URL.createObjectURL(r.blob), width: r.width, height: r.height, ms: r.ms } });
  },
}));
