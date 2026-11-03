import { useEffect } from 'react';
import { useSceneStore } from './cad/sceneStore';
import { useEditorStore } from './features/selection/editorStore';
import { cancelPending, commitPending } from './features/selection/featureFlow';
import { openProject, saveProject } from './features/projects/projectActions';

/**
 * Ctrl+Z 실행 취소, Ctrl+Shift+Z / Ctrl+Y 다시 실행, Delete 선택 객체 삭제, Esc 선택 해제,
 * W 이동 모드, E 회전 모드, S 스냅 전환, F 화면 맞춤, R 사각형 그리기, C 원 그리기, P 다각형 그리기 (Esc: 그리기 끝내기),
 * Ctrl+S 저장, Ctrl+Shift+S 다른 이름으로 저장, Ctrl+O 열기 (입력 중에도 동작)
 * 솔리드웍스식: Ctrl+1 정면 · 2 후면 · 3 좌측면 · 4 우측면 · 5 윗면 · 6 아랫면 · 7 등각 · 8 스케치에 수직, 스페이스 = 보기 방향 메뉴,
 * Enter = 속성 관리자 확인, Esc = 취소 (속성 관리자 → 평면 고르기 → 그리기 → 선택 순)
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
      const VIEWS = ['front', 'back', 'left', 'right', 'top', 'bottom', 'iso', 'normal'] as const;
      if (modKey && /^[1-8]$/.test(e.key)) {
        e.preventDefault(); // 브라우저 탭 전환 대신
        useEditorStore.getState().requestView(VIEWS[Number(e.key) - 1]!);
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
        const isSketch = s.history.present.model.sketches.some((k) => k.id === s.selectedId);
        s.submitNow(isSketch ? { type: 'delete_sketch', sketch: s.selectedId } : { type: 'delete_object', target: s.selectedId });
      } else if (e.key === 'Enter' && useEditorStore.getState().pending) {
        e.preventDefault();
        commitPending();
      } else if (e.key === ' ' && !mod) {
        e.preventDefault();
        window.dispatchEvent(new Event('ai3d:view-menu'));
      } else if (e.key === 'Escape') {
        const editor = useEditorStore.getState();
        if (editor.pending) cancelPending();
        else if (editor.pickingPlane) editor.setPickingPlane(false);
        else if (editor.drawTool) editor.setDrawTool(null); // 먼저 그리기만 끝내고 선택은 유지
        else {
          editor.selectPlane(null);
          s.select(null);
        }
      } else if (!mod && !e.altKey) {
        const editor = useEditorStore.getState();
        if (key === 'w' || key === 'e') {
          editor.setDrawTool(null);
          editor.setTransformMode(key === 'w' ? 'translate' : 'rotate');
        }
        else if (key === 's') editor.toggleSnap();
        else if (key === 'f') editor.requestFit();
        else if (key === 'r') editor.setDrawTool(editor.drawTool === 'rectangle' ? null : 'rectangle');
        else if (key === 'c') editor.setDrawTool(editor.drawTool === 'circle' ? null : 'circle');
        else if (key === 'p') editor.setDrawTool(editor.drawTool === 'polygon' ? null : 'polygon');
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
