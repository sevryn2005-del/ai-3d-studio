/** 새 프로젝트 / 열기 / 저장. UI(툴바·단축키)는 이 함수들만 호출한다. */
import { emptyModel, type Workspace } from '../../cad/commandTypes';
import { useAppScreen } from './appScreen';
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
  // 시작 화면에서 작업 모드를 고른다 (모드 없는 예전 통합 화면으로 시작한 경우도 같다)
  useAppScreen.getState().setScreen('home');
  return true;
}

/** 시작 화면에서 모드를 골라 새로 시작: 설계 = 빈 부품(정면·윗면·우측면 평면과 원점), 모델링 = 빈 장면 */
export function startNew(workspace: Workspace): void {
  const model = { ...emptyModel(), workspace };
  useSceneStore.getState().reset(model);
  useProjectStore.getState().set({ name: UNTITLED, handle: null, savedModel: model });
  clearDraft();
  useAppScreen.getState().setScreen('editor');
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
    useAppScreen.getState().setScreen('editor');
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

/** 임시 저장된 작업을 복원한다 (시작 화면의 "이어서 작업", 홈을 건너뛰는 시작). 없으면 false */
export function restoreDraft(): boolean {
  const draft = readDraft();
  if (!draft) return false;
  const model = draft.project.model;
  useSceneStore.getState().reset(model);
  useProjectStore.getState().set({ name: draft.project.name, savedModel: draft.clean ? model : null });
  notify('이전 작업을 복원했습니다');
  useAppScreen.getState().setScreen('editor');
  return true;
}
