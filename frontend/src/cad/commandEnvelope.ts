/**
 * 명령 봉투: 어떤 상태(baseRevision)를 보고 만든 어떤 명령(commandId)인지.
 *
 * 처리 순서 (sceneStore.submit)
 *  1. 이미 적용한 commandId → 'duplicate' (아무것도 바꾸지 않음. 재시도·이벤트 중복에 안전)
 *  2. baseRevision ≠ 현재 리비전 → 'stale' (그사이 다른 변경이 있었음. 원본·이력 보존)
 *  3. 명령 검증·실행 실패(잘못된 대상 등) → 'rejected' (원본·이력 보존)
 *  4. 적용 → 'applied', 이력 1건, 새 리비전
 *
 * 대상 ID 와 입력 파라미터는 command 안에 있다 (예: set_transform 의 target, position, rotation).
 */
import { z } from 'zod';
import type { ObjectId } from './commandTypes';

export const CommandEnvelopeSchema = z.strictObject({
  commandId: z.string().min(1).max(100),
  baseRevision: z.number().int().min(0),
  command: z.unknown(),
});
export type CommandEnvelope = z.infer<typeof CommandEnvelopeSchema>;

export type SubmitResult =
  | { status: 'applied'; revision: number; affectedId: ObjectId | null }
  | { status: 'duplicate'; revision: number }
  | { status: 'stale'; error: string; baseRevision: number; currentRevision: number }
  | { status: 'rejected'; error: string };

export function newCommandId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  return `cmd-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
