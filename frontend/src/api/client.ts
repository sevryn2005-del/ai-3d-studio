/**
 * 백엔드 API 클라이언트.
 * 모든 요청은 Vite 프록시를 통해 /api → FastAPI(8000) 로 전달된다.
 * LLM API 키는 백엔드에만 존재하며 브라우저로 절대 전달하지 않는다.
 *
 * 서버 응답도 신뢰하지 않고 Zod 로 검증한다 (버전 불일치·프록시 오류 페이지 등을 조기에 발견).
 */
import type { z } from 'zod';
import { appConfig } from './config';

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

const TIMEOUT_MS = 10_000;

async function request<S extends z.ZodType>(
  path: string,
  schema: S,
  init: RequestInit & { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<z.infer<S>> {
  const timeout = AbortSignal.timeout(init.timeoutMs ?? TIMEOUT_MS);
  const signal = init.signal ? AbortSignal.any([init.signal, timeout]) : timeout;
  const res = await fetch(`${appConfig().apiBase}${path}`, { ...init, signal });
  if (!res.ok) throw new ApiError(res.status, `${res.status} ${res.statusText}`);
  const parsed = schema.safeParse(await res.json().catch(() => undefined));
  if (!parsed.success) throw new ApiError(res.status, '서버 응답 형식이 올바르지 않습니다');
  return parsed.data;
}

export function apiGet<S extends z.ZodType>(path: string, schema: S, signal?: AbortSignal) {
  return request(path, schema, { method: 'GET', signal });
}

export function apiPost<S extends z.ZodType>(path: string, body: unknown, schema: S, signal?: AbortSignal, timeoutMs?: number) {
  return request(path, schema, {
    timeoutMs,
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal,
  });
}

/**
 * 파일(바이너리)을 받는 POST. 실패 시 서버의 {issues} 메시지를 ApiError 로 전달한다.
 */
export async function apiPostBlob(path: string, body: unknown, signal?: AbortSignal): Promise<Blob> {
  const timeout = AbortSignal.timeout(120_000);
  const res = await fetch(`${appConfig().apiBase}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => null)) as { issues?: { message: string }[] } | null;
    throw new ApiError(res.status, data?.issues?.map((i) => i.message).join(', ') || `${res.status} ${res.statusText}`);
  }
  return res.blob();
}

export function apiPut<S extends z.ZodType>(path: string, body: unknown, schema: S) {
  return request(path, schema, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
