/** 새 프로젝트 / 열기 / 저장. UI(툴바·단축키)는 이 함수들만 호출한다. */
import { createDefaultModel } from '../../cad/defaultModel';
import { useSceneStore } from '../../cad/sceneStore';
import { clearDraft, readDraft, writeDraft } from './draft';
import { nameFromFileName, parseProject, PROJECT_EXTENSION, serializeProject } from './projectFile';
import { openTextFile, PickerCancelled, saveTextFile } from './projectStorage';
import { HostSaveDeclined } from './hostDownloads';
import { confirmDialog } from '../dialogs/confirmStore';
import { isDirtyNow, UNTITLED, useProjectStore } from './projectStore';

const DISCARD_PROMPT = '저장하지 않은 변경 사항이 있습니다. 계속하면 사라집니다. 계속할까요?';

function notify(message: string) {
  useProjectStore.getState().set({ notice: message });
  setTimeout(() => {
    if (useProjectStore.getState().notice === message) useProjectStore.getState().set({ notice: null });
  }, 4000);
}

function fail(prefix: string, e: unknown) {
  useSceneStore.getState().reportError(`${prefix}: ${e instanceof Error ? e.message : String(e)}`);
}

// window.confirm 은 iframe·일부 WebView 에서 동작하지 않거나 항상 false 를 돌려주므로 앱 내부 확인 창을 쓴다
export async function newProject(): Promise<boolean> {
  if (isDirtyNow() && !(await confirmDialog(DISCARD_PROMPT, '새 프로젝트'))) return false;
  const model = createDefaultModel();
  useSceneStore.getState().reset(model);
  useProjectStore.getState().set({ name: UNTITLED, handle: null, savedModel: model });
  clearDraft();
  return true;
}

export async function openProject(): Promise<boolean> {
  if (isDirtyNow() && !(await confirmDialog(DISCARD_PROMPT, '열기'))) return false;
  try {
    const { text, fileName, handle } = await openTextFile();
    const r = parseProject(text);
    if (!r.ok) {
      useSceneStore.getState().reportError(`'${fileName}'을(를) 열 수 없습니다: ${r.error}`);
      return false;
    }
    const model = r.project.model;
    useSceneStore.getState().reset(model);
    useProjectStore.getState().set({ name: nameFromFileName(fileName), handle, savedModel: model });
    writeDraft(nameFromFileName(fileName), model, true);
    notify(`열었습니다: ${fileName}`);
    return true;
  } catch (e) {
    if (e instanceof PickerCancelled) return false;
    fail('열기 실패', e);
    return false;
  }
}

export async function saveProject({ saveAs = false } = {}): Promise<boolean> {
  // 입력 중인 숫자 필드가 있으면 먼저 확정 (blur 시 명령 발행)
  (document.activeElement as HTMLElement | null)?.blur?.();
  await Promise.resolve();

  const model = useSceneStore.getState().history.present.model;
  const { name, handle } = useProjectStore.getState();
  try {
    const target = await saveTextFile(serializeProject(name, model), `${name}${PROJECT_EXTENSION}`, saveAs ? null : handle);
    const savedName = nameFromFileName(target.fileName);
    useProjectStore.getState().set({ name: savedName, handle: target.handle, savedModel: model });
    writeDraft(savedName, model, true);
    notify(`저장했습니다: ${target.fileName}`);
    return true;
  } catch (e) {
    if (e instanceof PickerCancelled || e instanceof HostSaveDeclined) return false;
    fail('저장 실패', e);
    return false;
  }
}

/** 앱 시작 시(첫 렌더 전) 임시 저장된 작업을 복원한다. */
export function restoreDraft(): void {
  const draft = readDraft();
  if (!draft) return;
  const model = draft.project.model;
  useSceneStore.getState().reset(model);
  useProjectStore.getState().set({ name: draft.project.name, savedModel: draft.clean ? model : null });
  notify('이전 작업을 복원했습니다');
}
