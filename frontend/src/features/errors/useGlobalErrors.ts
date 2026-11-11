/**
 * 어디서도 잡히지 않은 오류 (비동기 작업·이벤트 처리기)를 알림 상자로 — 콘솔에만 묻혀 사용자가 영문도 모르는 일이 없게.
 * 브라우저 소음(ResizeObserver 등)과 사용자가 취소한 파일 고르기는 거른다.
 */
import { useEffect } from 'react';
import { useNoticeStore } from './noticeStore';

export function useGlobalErrors() {
  useEffect(() => {
    const report = (raw: unknown) => {
      const text = raw instanceof Error ? raw.message : typeof raw === 'string' ? raw : (raw as { message?: string })?.message ?? String(raw);
      // 사람이 일으킨 것으로 보이는 알려진 오류(네트워크 등)는 안내 규칙으로, 나머지는 '예상하지 못한 문제'로
      const known = /failed to fetch|networkerror|quota|json|timed? ?out/i.test(text);
      useNoticeStore.getState().report(text, known ? 'command' : 'unexpected');
    };
    const onError = (e: ErrorEvent) => report(e.error ?? e.message);
    const onRejection = (e: PromiseRejectionEvent) => report(e.reason);
    window.addEventListener('error', onError);
    window.addEventListener('unhandledrejection', onRejection);
    return () => {
      window.removeEventListener('error', onError);
      window.removeEventListener('unhandledrejection', onRejection);
    };
  }, []);
}
