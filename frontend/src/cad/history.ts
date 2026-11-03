/**
 * 실행 취소/다시 실행 히스토리 (순수 함수, 불변 구조).
 *
 * 각 항목은 "명령 + 실행 후 모델 스냅샷"을 저장한다.
 * - command 목록은 FeatureHistory(설계 이력)의 기반이 된다.
 * - 스냅샷 덕분에 undo/redo 가 O(1)이며, 백엔드 재계산 실패 시에도 즉시 복구 가능.
 */
import type { CadCommand, ModelDefinition } from './commandTypes';

export interface HistoryEntry {
  command: CadCommand | null; // null = 초기 상태. 일괄 실행이면 마지막 명령
  model: ModelDefinition;
  /** 여러 명령을 한 단계로 적용한 경우 전체 목록 (예: AI 요청 1건) */
  batch?: CadCommand[];
  source?: 'user' | 'ai';
}

export interface HistoryState {
  past: HistoryEntry[];
  present: HistoryEntry;
  future: HistoryEntry[];
}

export const HISTORY_LIMIT = 200;

export function createHistory(model: ModelDefinition): HistoryState {
  return { past: [], present: { command: null, model }, future: [] };
}

export function pushHistory(
  h: HistoryState,
  command: CadCommand,
  model: ModelDefinition,
  extra: Pick<HistoryEntry, 'batch' | 'source'> = {},
): HistoryState {
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  return { past, present: { command, model, ...extra }, future: [] };
}

export function undo(h: HistoryState): HistoryState {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return { past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h: HistoryState): HistoryState {
  const next = h.future[0];
  if (!next) return h;
  return { past: [...h.past, h.present], present: next, future: h.future.slice(1) };
}

export const canUndo = (h: HistoryState) => h.past.length > 0;
export const canRedo = (h: HistoryState) => h.future.length > 0;
