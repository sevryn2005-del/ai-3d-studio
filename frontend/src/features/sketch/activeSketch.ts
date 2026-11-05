import { useMemo } from 'react';
import { Matrix4 } from 'three';
import type { Sketch } from '../../cad/commandTypes';
import { selectModel, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { sketchWorldMatrix } from '../../cad/sketchPlane';
import { useEditorStore } from '../selection/editorStore';

/**
 * 지금 스케치 중인지 (솔리드웍스 "스케치 편집"): 스케치를 고르고 있거나 그리기 도구가 켜져 있을 때.
 * 피처 확정 대기·평면 고르기 중에는 아니다. frame = 스케치 좌표 → 월드 (스케치가 없으면 바닥 XY).
 */
export function useActiveSketch(): { sketch: Sketch | null; frame: Matrix4 } | null {
  const model = useSceneStore(selectModel);
  const sketch = useSceneStore(selectSelectedSketch);
  const drawTool = useEditorStore((s) => s.drawTool);
  const pending = useEditorStore((s) => s.pending);
  const picking = useEditorStore((s) => s.pickingPlane);
  return useMemo(() => {
    if (pending || picking || (!sketch && !drawTool)) return null;
    const frame = (sketch && sketchWorldMatrix(model, sketch)) || new Matrix4();
    return { sketch, frame };
  }, [model, sketch, drawTool, pending, picking]);
}
