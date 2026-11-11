import { useLayoutEffect, useRef, useState, type RefObject } from 'react';
import { useThree } from '@react-three/fiber';
import { TransformControls } from '@react-three/drei';
import type { Object3D } from 'three';
import { findObject } from '../../cad/commandExecutor';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { childIds } from '../../cad/modelGraph';
import { poseAt, trackOf } from '../../cad/animation';
import { transformFromObject3D, transformsEqual } from '../../cad/transformUtils';
import { DEG2RAD } from '../../cad/units';
import { newCommandId } from '../../cad/commandEnvelope';
import { selectSnap, useEditorStore } from '../../features/selection/editorStore';
import { matesOf } from '../../cad/mates';

/**
 * 선택된 객체에 이동/회전 기즈모를 붙인다.
 *
 * 미리보기와 커밋의 분리
 * - 드래그 시작: 명령 ID 를 만들고, 그 순간의 리비전을 기준 리비전으로 기록한다.
 * - 드래그 중: Three.js 객체만 움직인다 (설계 원본·이력·리비전은 그대로).
 * - 드래그 끝: set_transform 봉투를 submit 한다 → 드래그 1회 = 이력 1건.
 *   중복(같은 ID)·오래된 리비전(드래그 중 다른 변경)·잘못된 대상이면 원본을 바꾸지 않고,
 *   화면의 객체를 최신 설계 원본 값으로 되돌린다.
 */
export function SelectionGizmo({ activeRef }: { activeRef: RefObject<boolean> }) {
  const scene = useThree((s) => s.scene);
  const selectedId = useSceneStore((s) => s.selectedId);
  const model = useSceneStore(selectModel);
  const mode = useEditorStore((s) => s.transformMode);
  const exploded = useEditorStore((s) => s.exploded);
  const snap = useEditorStore(selectSnap);
  const [target, setTarget] = useState<Object3D | null>(null);
  /** 진행 중인 드래그의 명령 ID 와 기준 리비전 */
  const dragRef = useRef<{ commandId: string; baseRevision: number; objectId: string } | null>(null);

  // 객체 그룹은 같은 커밋에서 마운트되므로 effect 시점에는 씬에 존재한다.
  // 레이아웃 effect: 다음 프레임이 그려지기 전에 대상을 바꿔, 지워진 객체가 한 프레임이라도 붙어 있지 않게 한다.
  useLayoutEffect(() => {
    setTarget(selectedId ? (scene.getObjectByName(selectedId) ?? null) : null);
  }, [scene, selectedId, model]);

  // 불리언 생성 등으로 객체 그룹이 다시 만들어진 직후에는 effect 가 새 대상을 찾기 전까지 이전 객체를 가리킨다
  // 분해 보기 중에는 화면 위치가 설계 위치와 달라 기즈모를 숨긴다 (분해 이동량은 분해도 패널에서)
  if (!target || !selectedId || !inScene(target, scene) || exploded) return null;

  const commit = () => {
    const drag = dragRef.current;
    dragRef.current = null;
    if (!drag) return;
    const store = useSceneStore.getState();
    const current = findObject(store.history.present.model, drag.objectId);
    if (!current) return; // 드래그 중 객체가 사라짐: 되돌릴 대상도 없음
    const next = transformFromObject3D(target.position, target.rotation, snap);
    // 타임라인이 열려 있으면 (블렌더 자동 키처럼) 설계 위치 대신 지금 프레임에 키를 넣는다 — 최상위 객체만
    const tl = useEditorStore.getState().timeline;
    const topLevel = !store.history.present.model.objects.some((o) => childIds(o).includes(drag.objectId));
    const track = tl.open && topLevel ? trackOf(store.history.present.model, drag.objectId) : undefined;
    const shown = track ? poseAt(track, tl.frame) : current.transform; // 지금 화면에 보이던 자세
    if (transformsEqual(next, shown)) {
      applyTransform(target, shown); // 움직이지 않음(클릭만) 또는 반올림 잔여값 정리
      return;
    }
    const result = store.submit({
      commandId: drag.commandId,
      baseRevision: drag.baseRevision,
      command:
        tl.open && topLevel
          ? { type: 'insert_keyframe', target: drag.objectId, frame: Math.round(tl.frame), position: next.position, rotation: next.rotation }
          : useEditorStore.getState().dragWithMates && topLevel && matesOf(store.history.present.model, drag.objectId).length > 0
            ? { type: 'move_with_mates', target: drag.objectId, position: next.position, rotation: next.rotation }
            : { type: 'set_transform', target: drag.objectId, position: next.position, rotation: next.rotation },
    });
    // 적용되면 반올림된 값으로, 아니면 최신 설계 원본 값으로 맞춘다
    // (React props 가 같으면 R3F 가 다시 적용하지 않으므로 직접 설정)
    const latest = findObject(useSceneStore.getState().history.present.model, drag.objectId);
    // 메이트 끌기는 풀이가 자세를 바꾸므로 적용 뒤 설계 원본 값으로
    applyTransform(target, result.status === 'applied' ? (track ? next : (latest ?? current).transform) : track ? shown : (latest ?? current).transform);
  };

  return (
    <TransformControls
      object={target}
      mode={mode}
      space="world"
      size={0.9}
      translationSnap={snap.translation}
      rotationSnap={snap.rotation === null ? null : snap.rotation * DEG2RAD}
      onMouseDown={() => {
        activeRef.current = true;
        dragRef.current = {
          commandId: newCommandId(),
          baseRevision: useSceneStore.getState().history.present.revision,
          objectId: selectedId,
        };
      }}
      onMouseUp={() => {
        commit();
        // R3F 의 pointerup 처리(onPointerMissed)가 이 이벤트보다 늦게 올 수 있으므로 한 틱 뒤에 해제
        setTimeout(() => (activeRef.current = false), 0);
      }}
    />
  );
}

function inScene(obj: Object3D, scene: Object3D): boolean {
  for (let o: Object3D | null = obj; o; o = o.parent) if (o === scene) return true;
  return false;
}

function applyTransform(obj: Object3D, t: { position: number[]; rotation: number[] }) {
  obj.position.set(t.position[0]!, t.position[1]!, t.position[2]!);
  obj.rotation.set(t.rotation[0]! * DEG2RAD, t.rotation[1]! * DEG2RAD, t.rotation[2]! * DEG2RAD, 'XYZ');
}
