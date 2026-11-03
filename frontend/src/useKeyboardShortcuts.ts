import { useEffect } from 'react';
import { useSceneStore } from './cad/sceneStore';
import { useEditorStore } from './features/selection/editorStore';
import { openProject, saveProject } from './features/projects/projectActions';

/**
 * Ctrl+Z 실행 취소, Ctrl+Shift+Z / Ctrl+Y 다시 실행, Delete 선택 객체 삭제, Esc 선택 해제,
 * W 이동 모드, E 회전 모드, S 스냅 전환, F 화면 맞춤,
 * Ctrl+S 저장, Ctrl+Shift+S 다른 이름으로 저장, Ctrl+O 열기 (입력 중에도 동작)
 */
export function useKeyboardShortcuts() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // 팝업·메뉴·대화상자가 이미 처리한 키(예: Esc 로 닫기)는 무시 → 선택이 풀리지 않는다
      if (e.defaultPrevented) return;
      const modKey = e.ctrlKey || e.metaKey;
      if (modKey && e.key.toLowerCase() === 's') {
        e.preventDefault(); // 브라우저의 "페이지 저장" 대신
        void saveProject({ saveAs: e.shiftKey });
        return;
      }
      if (modKey && e.key.toLowerCase() === 'o') {
        e.preventDefault();
        void openProject();
        return;
      }
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) {
        // AI 채팅 입력창이 비어 있으면 Ctrl+Z / Ctrl+Shift+Z 는 모델 실행 취소로 (보낸 직후 AI 변경 되돌리기)
        const emptyChat = el.dataset.modelUndo === 'when-empty' && (el as HTMLTextAreaElement).value === '';
        const k = e.key.toLowerCase();
        if (!(emptyChat && modKey && (k === 'z' || k === 'y'))) return;
      }

      const s = useSceneStore.getState();
      const mod = e.ctrlKey || e.metaKey;
      const key = e.key.toLowerCase();

      if (mod && key === 'z' && !e.shiftKey) {
        e.preventDefault();
        s.undo();
      } else if (mod && (key === 'y' || (key === 'z' && e.shiftKey))) {
        e.preventDefault();
        s.redo();
      } else if ((e.key === 'Delete' || e.key === 'Backspace') && s.selectedId) {
        e.preventDefault();
        s.dispatch({ type: 'delete_object', target: s.selectedId });
      } else if (e.key === 'Escape') {
        s.select(null);
      } else if (!mod && !e.altKey) {
        const editor = useEditorStore.getState();
        if (key === 'w') editor.setTransformMode('translate');
        else if (key === 'e') editor.setTransformMode('rotate');
        else if (key === 's') editor.toggleSnap();
        else if (key === 'f') editor.requestFit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
