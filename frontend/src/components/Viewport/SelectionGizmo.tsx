import { useEffect, useState, type RefObject } from 'react';
import { useThree } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import type { Object3D } from 'three';
import { findObject } from '../../cad/commandExecutor';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { transformFromObject3D, transformsEqual } from '../../cad/transformUtils';
import { DEG2RAD } from '../../cad/units';
import { selectSnap, useEditorStore } from '../../features/selection/editorStore';

/**
 * 선택된 객체에 이동/회전 기즈모를 붙인다.
 *
 * 드래그 중에는 Three.js 객체만 움직이고(빠른 미리보기),
 * 드래그가 끝날 때 set_transform 명령을 "한 번" 발행한다 → 드래그 1회 = 히스토리 1단계.
 * 명령이 거부되면 Three.js 객체를 설계 원본 값으로 되돌린다.
 */
export function SelectionGizmo({ activeRef }: { activeRef: RefObject<boolean> }) {
  const scene = useThree((s) => s.scene);
  const selectedId = useSceneStore((s) => s.selectedId);
  const model = useSceneStore(selectModel);
  const mode = useEditorStore((s) => s.transformMode);
  const snap = useEditorStore(selectSnap);
  const [target, setTarget] = useState<Object3D | null>(null);

  // 객체 그룹은 같은 커밋에서 마운트되므로 effect 시점에는 씬에 존재한다.
  useEffect(() => {
    setTarget(selectedId ? (scene.getObjectByName(selectedId) ?? null) : null);
  }, [scene, selectedId, model]);

  if (!target || !selectedId) return null;

  const commit = () => {
    const current = findObject(useSceneStore.getState().history.present.model, selectedId);
    if (!current) return;
    const next = transformFromObject3D(target.position, target.rotation, snap);
    if (transformsEqual(next, current.transform)) {
      applyTransform(target, current.transform); // 반올림 잔여값 정리
      return;
    }
    const result = useSceneStore.getState().dispatch({
      type: 'set_transform',
      target: selectedId,
      position: next.position,
      rotation: next.rotation,
    });
    // 성공 시에도 반올림된 값으로 맞춘다 (React props 가 같으면 R3F 가 다시 적용하지 않으므로)
    applyTransform(target, result.ok ? next : current.transform);
  };

  return (
    <TransformControls
      object={target}
      mode={mode}
      space="world"
      size={0.9}
      translationSnap={snap.translation}
      rotationSnap={snap.rotation === null ? null : snap.rotation * DEG2RAD}
      onMouseDown={() => (activeRef.current = true)}
      onMouseUp={() => {
        commit();
        // R3F 의 pointerup 처리(onPointerMissed)가 이 이벤트보다 늦게 올 수 있으므로 한 틱 뒤에 해제
        setTimeout(() => (activeRef.current = false), 0);
      }}
    />
  );
}

function applyTransform(obj: Object3D, t: { position: number[]; rotation: number[] }) {
  obj.position.set(t.position[0]!, t.position[1]!, t.position[2]!);
  obj.rotation.set(t.rotation[0]! * DEG2RAD, t.rotation[1]! * DEG2RAD, t.rotation[2]! * DEG2RAD, 'XYZ');
}
