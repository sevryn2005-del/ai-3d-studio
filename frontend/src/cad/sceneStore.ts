/**
 * 전역 편집기 상태 (Zustand).
 *
 * 모델 변경은 반드시 dispatch(command) 를 통해서만 일어난다.
 * UI 컴포넌트가 objects 를 직접 수정하지 않는다.
 */
import { create } from 'zustand';
import type { CadCommand, ModelDefinition, ObjectId } from './commandTypes';
import { executeBatch, executeCommand, type BatchResult, type ExecuteResult } from './commandExecutor';
import { canRedo, canUndo, createHistory, pushHistory, redo, undo, type HistoryState } from './history';
import { createDefaultModel } from './defaultModel';

interface SceneState {
  history: HistoryState;
  selectedId: ObjectId | null;
  lastError: string | null;

  dispatch: (command: CadCommand | unknown) => ExecuteResult;
  /** 여러 명령을 한 단계로 적용 (전부 성공해야 적용, 실행 취소 1번으로 되돌림) */
  dispatchBatch: (commands: unknown[], source?: 'user' | 'ai') => BatchResult;
  select: (id: ObjectId | null) => void;
  undo: () => void;
  redo: () => void;
  reset: (model?: ModelDefinition) => void;
  clearError: () => void;
  /** 명령 이외의 작업(내보내기 등) 실패를 상태바에 표시 */
  reportError: (message: string) => void;
}

export const useSceneStore = create<SceneState>((set, get) => ({
  history: createHistory(createDefaultModel()),
  selectedId: 'box_1',
  lastError: null,

  dispatch: (command) => {
    const { history } = get();
    const result = executeCommand(history.present.model, command);
    if (!result.ok) {
      set({ lastError: result.error });
      return result;
    }
    set((s) => ({
      history: pushHistory(history, result.command, result.model),
      lastError: null,
      selectedId:
        result.command.type === 'delete_object' && s.selectedId === result.command.target
          ? null
          : (result.affectedId ?? s.selectedId),
    }));
    return result;
  },

  dispatchBatch: (commands, source = 'user') => {
    const { history } = get();
    const result = executeBatch(history.present.model, commands);
    if (!result.ok) {
      set({ lastError: result.error });
      return result;
    }
    const last = result.commands[result.commands.length - 1]!;
    set((s) => ({
      history: pushHistory(history, last, result.model, { batch: result.commands, source }),
      lastError: null,
      selectedId: result.model.objects.some((o) => o.id === result.affectedId)
        ? result.affectedId
        : result.model.objects.some((o) => o.id === s.selectedId)
          ? s.selectedId
          : null,
    }));
    return result;
  },

  select: (id) => set({ selectedId: id }),

  undo: () =>
    set((s) => {
      const history = undo(s.history);
      return { history, selectedId: keepSelection(history, s.selectedId), lastError: null };
    }),

  redo: () =>
    set((s) => {
      const history = redo(s.history);
      return { history, selectedId: keepSelection(history, s.selectedId), lastError: null };
    }),

  reset: (model) =>
    set({ history: createHistory(model ?? createDefaultModel()), selectedId: null, lastError: null }),

  clearError: () => set({ lastError: null }),
  reportError: (message) => set({ lastError: message }),
}));

function keepSelection(h: HistoryState, id: ObjectId | null): ObjectId | null {
  return id && h.present.model.objects.some((o) => o.id === id) ? id : null;
}

// ---- 셀렉터 ---------------------------------------------------------------
export const selectModel = (s: SceneState) => s.history.present.model;
export const selectCanUndo = (s: SceneState) => canUndo(s.history);
export const selectCanRedo = (s: SceneState) => canRedo(s.history);
export const selectSelectedObject = (s: SceneState) =>
  s.history.present.model.objects.find((o) => o.id === s.selectedId) ?? null;
