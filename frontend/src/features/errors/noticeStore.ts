/**
 * 알림 상자 (오른쪽 아래): 오류를 안내(errorGuide)로 바꿔 쌓는다. 같은 오류가 잇따르면 한 상자에 횟수만 올린다.
 * 오류는 10초, 경고·안내는 7초 뒤 저절로 닫힌다 (마우스를 올리면 멈춤 — 컴포넌트에서).
 */
import { create } from 'zustand';
import { explainError, isNoise, unexpectedError, type ErrorGuide } from './errorGuide';

export interface Notice extends ErrorGuide {
  id: number;
  raw: string;
  count: number;
  at: number;
}

interface NoticeState {
  notices: Notice[];
  /** 날것 오류 → 안내 상자. kind 'unexpected' = 프로그램 오류 */
  report: (raw: string, kind?: 'command' | 'unexpected') => void;
  dismiss: (id: number) => void;
  clear: () => void;
}

const MAX = 4;
const MERGE_MS = 15_000;
let seq = 0;

export const useNoticeStore = create<NoticeState>((set) => ({
  notices: [],
  report: (raw, kind = 'command') => {
    const text = String(raw ?? '').trim();
    if (!text || isNoise(text)) return;
    const guide = kind === 'unexpected' ? unexpectedError(text) : explainError(text);
    const now = Date.now();
    set((s) => {
      const same = s.notices.find((n) => n.raw === text && now - n.at < MERGE_MS);
      if (same) return { notices: s.notices.map((n) => (n === same ? { ...n, count: n.count + 1, at: now } : n)) };
      return { notices: [...s.notices, { ...guide, id: ++seq, raw: text, count: 1, at: now }].slice(-MAX) };
    });
  },
  dismiss: (id) => set((s) => ({ notices: s.notices.filter((n) => n.id !== id) })),
  clear: () => set({ notices: [] }),
}));
