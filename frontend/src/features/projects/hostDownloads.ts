/**
 * 웹 호스트가 제공하는 저장 기능 (예: claude.ai 의 공유 페이지).
 *
 * 그런 호스트는 페이지를 샌드박스 iframe 에 넣어 일반 다운로드(<a download>)를 막고, 대신
 * window.claude.use('downloads') 로 "보는 사람이 확인하는 저장"을 제공한다. 이 경우 허용된 확장자만
 * 저장되므로, 목록에 없는 CAD 형식(.stl .3mf .glb)은 ZIP 으로 감싸고 프로젝트는 .ai3d.json 으로 저장한다.
 * 이 기능이 없는 환경(일반 브라우저, Windows 앱, 로컬 모드)에서는 null 을 돌려 기존 방식이 쓰인다.
 */
import { zipSync } from 'fflate';

interface HostDownloads {
  save(req: { filename: string; data: Blob | ArrayBuffer | ArrayBufferView | string }): Promise<{ status: string }>;
}

declare global {
  interface Window {
    claude?: { use?: (name: string) => Promise<unknown> };
  }
}

/** 호스트가 허용하는 확장자 (그 외는 ZIP 으로 감싼다) */
const HOST_ALLOWED = new Set(['json', 'txt', 'md', 'csv', 'zip', 'pdf', 'png', 'jpg', 'jpeg', 'svg', 'html']);

let cached: Promise<HostDownloads | null> | null = null;

export function hostDownloads(): Promise<HostDownloads | null> {
  if (!cached) {
    const use = typeof window !== 'undefined' ? window.claude?.use : undefined;
    cached = use ? use('downloads').then((d) => (d as HostDownloads | null) ?? null).catch(() => null) : Promise.resolve(null);
  }
  return cached;
}

/** 테스트용 */
export function resetHostDownloads() {
  cached = null;
}

/** 호스트 저장 규칙에 맞는 파일 이름·내용으로 바꾼다 */
export async function adaptForHost(blob: Blob, fileName: string): Promise<{ filename: string; data: Blob | Uint8Array }> {
  if (fileName.toLowerCase().endsWith('.ai3d')) return { filename: `${fileName}.json`, data: blob };
  const ext = fileName.split('.').pop()?.toLowerCase() ?? '';
  if (HOST_ALLOWED.has(ext)) return { filename: fileName, data: blob };
  const bytes = new Uint8Array(await blob.arrayBuffer());
  return { filename: `${fileName}.zip`, data: zipSync({ [fileName]: bytes }) };
}

export class HostSaveDeclined extends Error {}

/** 호스트 저장을 시도한다. 호스트 기능이 없으면 false (호출자가 일반 다운로드 사용). */
export async function saveViaHost(blob: Blob, fileName: string): Promise<boolean> {
  const host = await hostDownloads();
  if (!host) return false;
  const { filename, data } = await adaptForHost(blob, fileName);
  try {
    await host.save({ filename, data });
    return true;
  } catch (e) {
    const code = (e as { code?: string })?.code;
    if (code === 'declined') throw new HostSaveDeclined('저장을 취소했습니다');
    throw new Error((e as { message?: string })?.message ?? '파일을 저장할 수 없습니다');
  }
}
