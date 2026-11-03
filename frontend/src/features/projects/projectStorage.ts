/**
 * 로컬 파일 저장/열기 (플랫폼별 구현을 이 인터페이스 뒤에 둔다).
 *
 * - 브라우저(Chromium): File System Access API → 같은 파일에 다시 저장 가능
 * - 그 외 브라우저: 다운로드 / 파일 선택 창
 * - 저장 기능을 제공하는 웹 호스트(샌드박스 iframe): hostDownloads.ts
 * - Windows 앱(Tauri, 예정): 네이티브 대화상자 구현을 추가
 */
import { PROJECT_EXTENSION } from './projectFile';
import { saveViaHost } from './hostDownloads';

export interface SaveTarget {
  /** 사용자에게 보이는 파일 이름 */
  fileName: string;
  /** 같은 위치에 다시 저장할 수 있는 핸들 (지원하는 플랫폼만) */
  handle: FileSystemFileHandle | null;
}

export class PickerCancelled extends Error {}

const TYPES = [{ description: 'AI 3D Studio 프로젝트', accept: { 'application/json': [PROJECT_EXTENSION] } }];

export async function saveTextFile(
  text: string,
  suggestedName: string,
  existing: FileSystemFileHandle | null,
): Promise<SaveTarget> {
  if (existing || window.showSaveFilePicker) {
    let handle = existing;
    if (!handle) {
      try {
        handle = await window.showSaveFilePicker!({ suggestedName, types: TYPES });
      } catch (e) {
        if (e instanceof DOMException && e.name === 'AbortError') throw new PickerCancelled();
        // iframe 안 등 파일 선택 창이 허용되지 않는 환경(SecurityError) → 다운로드 방식으로
        handle = null;
      }
    }
    if (handle) {
      const writable = await handle.createWritable();
      await writable.write(text);
      await writable.close();
      return { fileName: handle.name, handle };
    }
  }
  await downloadBlob(new Blob([text], { type: 'application/json' }), suggestedName);
  return { fileName: suggestedName, handle: null };
}

export async function openTextFile(): Promise<{ text: string; fileName: string; handle: FileSystemFileHandle | null }> {
  if (window.showOpenFilePicker) {
    let handle: FileSystemFileHandle | null = null;
    try {
      [handle] = (await window.showOpenFilePicker({ types: TYPES })) as [FileSystemFileHandle];
    } catch (e) {
      if (e instanceof DOMException && e.name === 'AbortError') throw new PickerCancelled();
      // 허용되지 않는 환경(SecurityError) → 파일 선택 input 으로
    }
    if (handle) {
      const file = await handle.getFile();
      return { text: await file.text(), fileName: file.name, handle };
    }
  }
  const file = await pickFileWithInput(`${PROJECT_EXTENSION},application/json`);
  return { text: await file.text(), fileName: file.name, handle: null };
}

/** 파일 내려받기. 저장 기능을 제공하는 호스트에서는 그 기능을, 그 외에는 일반 다운로드를 쓴다. */
export async function downloadBlob(blob: Blob, fileName: string): Promise<void> {
  if (await saveViaHost(blob, fileName)) return;
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function pickFileWithInput(accept: string): Promise<File> {
  return new Promise((resolve, reject) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    input.addEventListener('change', () => {
      const file = input.files?.[0];
      input.remove();
      if (file) resolve(file);
      else reject(new PickerCancelled());
    });
    input.addEventListener('cancel', () => {
      input.remove();
      reject(new PickerCancelled());
    });
    document.body.appendChild(input);
    input.click();
  });
}
