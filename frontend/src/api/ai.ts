/** AI API (로컬 백엔드). 응답 형식은 backend/app/api/ai.py 와 일치해야 한다. */
import { z } from 'zod';
import type { ModelDefinition } from '../cad/commandTypes';
import { apiGet, apiPost, apiPut } from './client';

const PriceSchema = z.object({ input: z.number(), output: z.number(), cacheRead: z.number(), cacheWrite: z.number() });
export type Price = z.infer<typeof PriceSchema>;

export const AiSettingsSchema = z.object({
  enabled: z.boolean(),
  model: z.string(),
  keyConfigured: z.boolean(),
  keySource: z.enum(['saved', 'environment']).nullable(),
  keyHint: z.string().nullable(),
  models: z.array(z.object({ id: z.string(), label: z.string(), price: PriceSchema })),
});
export type AiSettings = z.infer<typeof AiSettingsSchema>;

const TotalsSchema = z.object({ requests: z.number(), inputTokens: z.number(), outputTokens: z.number(), costUsd: z.number() });
export type UsageTotals = z.infer<typeof TotalsSchema>;

const UsageRecordSchema = z.object({
  time: z.string(),
  model: z.string(),
  kind: z.string(),
  requests: z.number(),
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  costUsd: z.number(),
});
export type UsageRecord = z.infer<typeof UsageRecordSchema>;

export const UsageSummarySchema = z.object({
  today: TotalsSchema,
  month: TotalsSchema,
  all: TotalsSchema,
  recent: z.array(UsageRecordSchema),
});
export type UsageSummary = z.infer<typeof UsageSummarySchema>;

export const ChatResponseSchema = z.object({
  kind: z.enum(['commands', 'question', 'message', 'refused', 'error']),
  message: z.string(),
  commands: z.array(z.unknown()),
  options: z.array(z.string()),
  issues: z.array(z.string()),
  code: z.string().optional(),
  usage: UsageRecordSchema.optional(),
  month: TotalsSchema.optional(),
});
export type ChatResponse = z.infer<typeof ChatResponseSchema>;

export interface ChatRequest {
  model: ModelDefinition;
  selectedId: string | null;
  history: { role: 'user' | 'assistant'; text: string }[];
  message: string;
}

/** AI 응답은 수십 초가 걸릴 수 있다 */
export const CHAT_TIMEOUT_MS = 180_000;

export const getAiSettings = () => apiGet('/ai/settings', AiSettingsSchema);
export const updateAiSettings = (patch: Record<string, unknown>) =>
  apiPut('/ai/settings', patch, AiSettingsSchema.extend({ ok: z.boolean().optional() }).partial({ models: true }).passthrough());
export const getAiUsage = () => apiGet('/ai/usage', UsageSummarySchema);
export const sendChat = (req: ChatRequest, signal?: AbortSignal) =>
  apiPost('/ai/chat', req, ChatResponseSchema, signal, CHAT_TIMEOUT_MS);
