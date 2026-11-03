/**
 * 전역 편집기 상태 (Zustand).
 *
 * 모델 변경은 반드시 dispatch(command) / submit(봉투) 를 통해서만 일어난다.
 * UI 컴포넌트가 objects 를 직접 수정하지 않는다.
 * submit 은 명령 ID·기준 리비전을 검사하는 경로다 (commandEnvelope.ts). 첫 적용 경로: 이동 기즈모.
 */
import { create } from 'zustand';
import type { CadCommand, ModelDefinition, ObjectId } from './commandTypes';
import { executeBatch, executeCommand, type BatchResult, type ExecuteResult } from './commandExecutor';
import { canRedo, canUndo, createHistory, pushHistory, redo, undo, type HistoryState } from './history';
import { createDefaultModel } from './defaultModel';
import { CommandEnvelopeSchema, newCommandId, type SubmitResult } from './commandEnvelope';

interface SceneState {
  history: HistoryState;
  selectedId: ObjectId | null;
  lastError: string | null;

  dispatch: (command: CadCommand | unknown) => ExecuteResult;
  /** 명령 봉투 적용: 중복 → 오래된 리비전 → 검증 순으로 거른 뒤 이력 1건으로 커밋 */
  submit: (envelope: unknown) => SubmitResult;
  /** 지금 리비전을 기준으로 새 명령 ID 를 붙여 submit (입력 필드·버튼처럼 즉시 확정되는 편집) */
  submitNow: (command: CadCommand) => SubmitResult;
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

  submit: (raw) => {
    const env = CommandEnvelopeSchema.safeParse(raw);
    if (!env.success) {
      const error = '잘못된 명령 봉투입니다';
      set({ lastError: error });
      return { status: 'rejected', error };
    }
    const { commandId, baseRevision, command } = env.data;
    const { history } = get();
    const current = history.present.revision;

    if (history.appliedCommandIds.includes(commandId)) return { status: 'duplicate', revision: current };
    if (baseRevision !== current) {
      const error = '편집하는 동안 다른 변경이 먼저 적용되어 이 편집을 반영하지 않았습니다';
      set({ lastError: error });
      return { status: 'stale', error, baseRevision, currentRevision: current };
    }
    const result = executeCommand(history.present.model, command);
    if (!result.ok) {
      set({ lastError: result.error });
      return { status: 'rejected', error: result.error };
    }
    const next = pushHistory(history, result.command, result.model, { commandId });
    set((s) => ({
      history: next,
      lastError: null,
      selectedId: result.command.type === 'delete_object' && s.selectedId === result.command.target ? null : (result.affectedId ?? s.selectedId),
    }));
    return { status: 'applied', revision: next.present.revision, affectedId: result.affectedId };
  },

  submitNow: (command) =>
    get().submit({ commandId: newCommandId(), baseRevision: get().history.present.revision, command }),

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
      selectedId: selectable(result.model, result.affectedId)
        ? result.affectedId
        : selectable(result.model, s.selectedId)
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

/** 선택 가능한 ID: 객체 또는 스케치 (같은 ID 이름공간) */
function selectable(model: ModelDefinition, id: ObjectId | null): id is ObjectId {
  return !!id && (model.objects.some((o) => o.id === id) || model.sketches.some((s) => s.id === id));
}

function keepSelection(h: HistoryState, id: ObjectId | null): ObjectId | null {
  return selectable(h.present.model, id) ? id : null;
}

// ---- 셀렉터 ---------------------------------------------------------------
export const selectModel = (s: SceneState) => s.history.present.model;
export const selectRevision = (s: SceneState) => s.history.present.revision;
export const selectCanUndo = (s: SceneState) => canUndo(s.history);
export const selectCanRedo = (s: SceneState) => canRedo(s.history);
export const selectSelectedObject = (s: SceneState) =>
  s.history.present.model.objects.find((o) => o.id === s.selectedId) ?? null;
export const selectSelectedSketch = (s: SceneState) =>
  s.history.present.model.sketches.find((k) => k.id === s.selectedId) ?? null;
