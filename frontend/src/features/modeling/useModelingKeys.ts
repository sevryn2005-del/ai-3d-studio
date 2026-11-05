import { useEffect } from 'react';
import { useEditorStore } from '../selection/editorStore';
import { useModelingStore, type ModalKind } from './modelingStore';
import type { Brush } from '../../cad/sculpt';
import { typeKey } from './modalMath';
import {
  canStartModal, deleteSelection, growSelected, selectLinkedVerts, setSubsurfLevel, fillSelected, loopCutSelected, mergeSelected, selectAll, subdivideSelected, toggleEditMode,
} from './modelingOps';
import { cancelModal, confirmModal } from '../../components/Modeling/ModalController';

/**
 * 모델링 모드 키 (블렌더와 같은 배치). 설계 모드 단축키(useKeyboardShortcuts)는 모델링 모드에서 Ctrl 조합만 처리한다.
 * Tab 편집 모드 · Shift+A 추가 · G/R/S 이동·회전·크기 (X/Y/Z 축, 숫자 입력, Enter/클릭 확정, Esc/오른쪽 클릭 취소)
 * 편집 모드: 1/2/3 점·선·면, A 전체 선택(Alt+A 해제), E 돌출, I 인셋, X·Delete 삭제, Ctrl+R 루프 컷, M 병합, F 면 채우기, W 세분
 * 편집 모드: O 비례 편집(모달 중 휠·PageUp/Down = 반지름), Ctrl+B 베벨, Ctrl+L 연결 선택, Ctrl+숫자패드 ± 선택 넓히기·좁히기, Alt+클릭 루프 선택
 * Ctrl+1~3 세분 표면 단계, Ctrl+0 세분 표면 빼기
 * 보기: 숫자패드 1/3/7 정면·우측·위 (Ctrl = 반대쪽), 5 원근/직교, . · Home 화면 맞춤
 */
export function useModelingKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      const st = useModelingStore.getState();
      const key = e.key.toLowerCase();
      const mod = e.ctrlKey || e.metaKey;

      if (st.modal) {
        e.preventDefault();
        if (e.key === 'PageUp' || e.key === 'PageDown') {
          const r = st.proportional.radius * (e.key === 'PageUp' ? 1.1 : 1 / 1.1);
          st.setProportional({ radius: Math.max(0.1, Math.min(5000, r)) });
        } else if (e.key === 'Enter') confirmModal();
        else if (e.key === 'Escape' || (mod && key === 'z')) cancelModal();
        else if (!mod && (key === 'x' || key === 'y' || key === 'z') && st.modal.kind !== 'extrude' && st.modal.kind !== 'inset' && st.modal.kind !== 'bevel')
          st.setModal({ ...st.modal, axis: st.modal.axis === key ? null : key });
        else {
          const typed = typeKey(st.modal.typed, e.key);
          if (typed !== null) st.setModal({ ...st.modal, typed });
        }
        return;
      }

      // 보기 (숫자패드)
      const editor = useEditorStore.getState();
      const numpad: Record<string, () => void> = {
        Numpad1: () => editor.requestView(mod ? 'back' : 'front'),
        Numpad3: () => editor.requestView(mod ? 'left' : 'right'),
        Numpad7: () => editor.requestView(mod ? 'bottom' : 'top'),
        Numpad5: () => editor.toggleProjection(),
        NumpadDecimal: () => editor.requestFit(),
        Home: () => editor.requestFit(),
      };
      if (numpad[e.code]) {
        e.preventDefault();
        numpad[e.code]!();
        return;
      }
      // 스컬프트 모드 (블렌더): X 그리기 · I 부풀리기 · S 매끈하게 · G 잡아끌기 · Shift+T 평평하게 · [ ] 반지름 · Tab 편집 모드
      if (st.mode === 'sculpt' && !mod && !e.altKey) {
        const brushKey: Record<string, Brush> = { x: 'draw', i: 'inflate', s: 'smooth', g: 'grab' };
        if (e.shiftKey && key === 't') {
          e.preventDefault();
          return st.setSculpt({ brush: 'flatten' });
        }
        if (!e.shiftKey && brushKey[key]) {
          e.preventDefault();
          return st.setSculpt({ brush: brushKey[key]! });
        }
        if (e.key === '[' || e.key === ']') {
          e.preventDefault();
          const r = st.sculpt.radiusPx * (e.key === ']' ? 1.15 : 1 / 1.15);
          return st.setSculpt({ radiusPx: Math.round(Math.max(5, Math.min(400, r))) });
        }
        if (e.key === 'Escape') return st.setMode('object');
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        toggleEditMode();
        return;
      }
      if (e.key === 'Escape') {
        if (st.addMenu) st.setAddMenu(null);
        return;
      }
      if (e.shiftKey && key === 'a') {
        e.preventDefault();
        st.setAddMenu(st.mouse);
        return;
      }
      if (mod && /^[0-3]$/.test(e.key)) {
        e.preventDefault();
        setSubsurfLevel(Number(e.key));
        return;
      }
      if (mod && st.mode === 'edit' && (key === 'b' || key === 'l' || e.code === 'NumpadAdd' || e.code === 'NumpadSubtract')) {
        e.preventDefault(); // 브라우저 즐겨찾기·주소창·확대 대신
        if (key === 'b') {
          if (canStartModal('bevel')) st.startModal('bevel');
        } else if (key === 'l') selectLinkedVerts();
        else growSelected(e.code === 'NumpadSubtract');
        return;
      }
      if (mod && key === 'r') {
        e.preventDefault(); // 브라우저 새로 고침 대신
        if (st.mode === 'edit') loopCutSelected();
        return;
      }
      if (mod || e.shiftKey) return;
      const edit = st.mode === 'edit';
      if (e.altKey) {
        if (key === 'a' && edit) {
          e.preventDefault();
          selectAll(true);
        }
        return;
      }
      if (st.mode === 'sculpt') return;
      const MODAL_KEYS: Record<string, ModalKind> = { g: 'grab', r: 'rotate', s: 'scale', e: 'extrude', i: 'inset' };
      const modal = MODAL_KEYS[key];
      if (modal) {
        if ((modal === 'extrude' || modal === 'inset') && !edit) return;
        e.preventDefault();
        if (canStartModal(modal)) st.startModal(modal);
        return;
      }
      if (key === 'x' || e.key === 'Delete') {
        e.preventDefault();
        deleteSelection();
        return;
      }
      if (!edit) return;
      if (e.code === 'Digit1' || e.code === 'Digit2' || e.code === 'Digit3') {
        e.preventDefault();
        st.setSelectMode(e.code === 'Digit1' ? 'vert' : e.code === 'Digit2' ? 'edge' : 'face');
      } else if (key === 'a') {
        e.preventDefault();
        selectAll();
      } else if (key === 'o') st.setProportional({ enabled: !st.proportional.enabled });
      else if (key === 'm') mergeSelected();
      else if (key === 'f') fillSelected();
      else if (key === 'w') subdivideSelected();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
