import { useEffect } from 'react';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { DRAFT_DEBOUNCE_MS, writeDraft } from './draft';
import { useIsDirty, useProjectStore } from './projectStore';

/** 자동 임시 저장, 창 제목, 창 닫기 경고 */
export function useProjectLifecycle() {
  const model = useSceneStore(selectModel);
  const name = useProjectStore((s) => s.name);
  const dirty = useIsDirty();

  useEffect(() => {
    const t = setTimeout(() => writeDraft(name, model, !dirty), DRAFT_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [model, name, dirty]);

  useEffect(() => {
    document.title = `${dirty ? '• ' : ''}${name} — AI 3D Studio`;
  }, [name, dirty]);

  useEffect(() => {
    if (!dirty) return;
    const onBeforeUnload = (e: BeforeUnloadEvent) => e.preventDefault();
    window.addEventListener('beforeunload', onBeforeUnload);
    return () => window.removeEventListener('beforeunload', onBeforeUnload);
  }, [dirty]);
}
