import type { ReactNode } from 'react';
import { explodeOffset } from '../../cad/explode';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { useEditorStore } from '../../features/selection/editorStore';

/** 분해 보기 (형식 v41): 켜져 있으면 최상위 부품을 저장된 이동량만큼 옮겨 그린다 — 화면만, 설계 원본은 그대로 */
export function ExplodedPart({ id, children }: { id: string; children: ReactNode }) {
  const on = useEditorStore((s) => s.exploded);
  const offset = useSceneStore((s) => (on ? explodeOffset(selectModel(s), id) : null));
  if (!offset || offset.every((v) => v === 0)) return <>{children}</>;
  return <group position={offset}>{children}</group>;
}
