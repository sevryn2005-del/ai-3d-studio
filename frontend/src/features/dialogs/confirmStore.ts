/** 앱 내부 확인 창 (window.confirm 대체: iframe·WebView 에서도 일관되게 동작) */
import { create } from 'zustand';

interface ConfirmRequest {
  message: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

interface ConfirmState {
  request: ConfirmRequest | null;
  answer: (ok: boolean) => void;
}

export const useConfirmStore = create<ConfirmState>((set, get) => ({
  request: null,
  answer: (ok) => {
    get().request?.resolve(ok);
    set({ request: null });
  },
}));

export function confirmDialog(message: string, confirmLabel = '계속'): Promise<boolean> {
  return new Promise((resolve) => {
    useConfirmStore.getState().request?.resolve(false); // 이전 요청은 취소로 처리
    useConfirmStore.setState({ request: { message, confirmLabel, resolve } });
  });
}
