/** File System Access API (Chromium 계열) 최소 타입. 지원하지 않는 브라우저에서는 undefined. */
export {};

declare global {
  interface FilePickerAcceptType {
    description?: string;
    accept: Record<string, string[]>;
  }
  interface Window {
    showSaveFilePicker?: (options?: { suggestedName?: string; types?: FilePickerAcceptType[] }) => Promise<FileSystemFileHandle>;
    showOpenFilePicker?: (options?: { types?: FilePickerAcceptType[]; multiple?: boolean }) => Promise<FileSystemFileHandle[]>;
  }
}
