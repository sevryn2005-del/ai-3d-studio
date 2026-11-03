import { create } from 'zustand';
import type { ModelDefinition } from '../../cad/commandTypes';
import { selectModel, useSceneStore } from '../../cad/sceneStore';

export const UNTITLED = '제목 없음';

interface ProjectState {
  name: string;
  /** 같은 파일에 다시 저장하기 위한 핸들 (지원 플랫폼만) */
  handle: FileSystemFileHandle | null;
  /** 마지막으로 저장/열기한 시점의 모델 (불변 참조 비교로 미저장 여부 판단) */
  savedModel: ModelDefinition | null;
  /** 상태바에 잠시 표시할 안내 */
  notice: string | null;
  set: (patch: Partial<Omit<ProjectState, 'set'>>) => void;
}

export const useProjectStore = create<ProjectState>((set) => ({
  name: UNTITLED,
  handle: null,
  savedModel: useSceneStore.getState().history.present.model,
  notice: null,
  set: (patch) => set(patch),
}));

/** 저장 이후 변경이 있는가. 실행 취소로 저장 시점으로 돌아오면 다시 false (모델은 불변 객체). */
export function useIsDirty(): boolean {
  const model = useSceneStore(selectModel);
  const saved = useProjectStore((s) => s.savedModel);
  return model !== saved;
}

export function isDirtyNow(): boolean {
  return useSceneStore.getState().history.present.model !== useProjectStore.getState().savedModel;
}
