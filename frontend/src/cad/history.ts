/**
 * 실행 취소/다시 실행 히스토리 (순수 함수, 불변 구조).
 *
 * 각 항목은 "명령 + 실행 후 모델 스냅샷"을 저장한다.
 * - command 목록은 FeatureHistory(설계 이력)의 기반이 된다.
 * - 스냅샷 덕분에 undo/redo 가 O(1)이며, 백엔드 재계산 실패 시에도 즉시 복구 가능.
 *
 * 리비전: 커밋마다 새 번호(nextRevision)를 붙이고 재사용하지 않는다. 실행 취소하면 이전 항목의 번호로
 * 돌아가므로, 어떤 상태를 보고 만든 명령인지(baseRevision)를 현재 상태와 비교할 수 있다.
 * 적용한 명령 ID(appliedCommandIds)는 실행 취소와 무관하게 남겨, 같은 명령의 재시도를 무시한다.
 * (세션 안에서만 유지 — 프로젝트 파일 형식은 바꾸지 않는다)
 */
import type { CadCommand, ModelDefinition } from './commandTypes';

export interface HistoryEntry {
  command: CadCommand | null; // null = 초기 상태. 일괄 실행이면 마지막 명령
  model: ModelDefinition;
  /** 여러 명령을 한 단계로 적용한 경우 전체 목록 (예: AI 요청 1건) */
  batch?: CadCommand[];
  source?: 'user' | 'ai';
  /** 이 상태의 리비전 (초기 상태 0) */
  revision: number;
  /** 이 상태를 만든 명령 봉투의 ID (봉투로 적용된 경우) */
  commandId?: string;
}

export interface HistoryState {
  past: HistoryEntry[];
  present: HistoryEntry;
  future: HistoryEntry[];
  /** 다음 커밋에 붙일 리비전 (단조 증가) */
  nextRevision: number;
  /** 최근 적용한 명령 ID (중복 재시도 무시용) */
  appliedCommandIds: string[];
}

export const HISTORY_LIMIT = 200;
export const APPLIED_ID_LIMIT = 1000;

export function createHistory(model: ModelDefinition): HistoryState {
  return { past: [], present: { command: null, model, revision: 0 }, future: [], nextRevision: 1, appliedCommandIds: [] };
}

export function pushHistory(
  h: HistoryState,
  command: CadCommand,
  model: ModelDefinition,
  extra: Pick<HistoryEntry, 'batch' | 'source' | 'commandId'> = {},
): HistoryState {
  const past = [...h.past, h.present];
  if (past.length > HISTORY_LIMIT) past.splice(0, past.length - HISTORY_LIMIT);
  const applied = extra.commandId ? [...h.appliedCommandIds, extra.commandId].slice(-APPLIED_ID_LIMIT) : h.appliedCommandIds;
  return {
    past,
    present: { command, model, ...extra, revision: h.nextRevision },
    future: [],
    nextRevision: h.nextRevision + 1,
    appliedCommandIds: applied,
  };
}

export function undo(h: HistoryState): HistoryState {
  const prev = h.past[h.past.length - 1];
  if (!prev) return h;
  return { ...h, past: h.past.slice(0, -1), present: prev, future: [h.present, ...h.future] };
}

export function redo(h: HistoryState): HistoryState {
  const next = h.future[0];
  if (!next) return h;
  return { ...h, past: [...h.past, h.present], present: next, future: h.future.slice(1) };
}

export const canUndo = (h: HistoryState) => h.past.length > 0;
export const canRedo = (h: HistoryState) => h.future.length > 0;
