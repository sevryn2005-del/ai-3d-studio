/**
 * 솔리드웍스식 피처 흐름의 동작 (툴바·속성 관리자·뷰포트·단축키 공용).
 * 모든 변경은 명령(submitNow)으로만 — 미리보기·취소는 편집기 상태(editorStore)만 바꾼다.
 */
import type { CadCommand, StandardPlane } from '../../cad/commandTypes';
import { nextId } from '../../cad/commandExecutor';
import { selectModel, selectSelectedObject, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { resolveProfile, revolveProfileError } from '../../cad/sketch';
import { facesOf } from '../../cad/sketchPlane';
import { useEditorStore, type PendingFeature } from './editorStore';

export function pendingCommand(p: PendingFeature): CadCommand {
  return p.kind === 'extrude'
    ? { type: 'extrude', sketch: p.sketch, profile: p.profile, distance: p.distance }
    : { type: 'revolve', sketch: p.sketch, profile: p.profile, angle: p.angle };
}

/** 확인(✓): 명령 1건으로 확정. 거부되면 속성 관리자를 그대로 두고 이유는 상태바에 */
export function commitPending(): boolean {
  const ed = useEditorStore.getState();
  if (!ed.pending) return false;
  const r = useSceneStore.getState().submitNow(pendingCommand(ed.pending));
  if (r.status === 'applied') ed.setPending(null);
  return r.status === 'applied';
}

export function cancelPending() {
  useEditorStore.getState().setPending(null);
}

/** 기준 평면에 새 스케치 → 그 스케치를 선택하고 평면을 정면으로 본다 */
export function startSketchOnPlane(plane: StandardPlane['type']) {
  const scene = useSceneStore.getState();
  const id = nextId(selectModel(scene), 'sketch');
  const r = scene.submitNow({ type: 'create_sketch', id, plane: { type: plane, offset: 0 } });
  const ed = useEditorStore.getState();
  ed.setPickingPlane(false);
  ed.selectPlane(null);
  if (r.status === 'applied') ed.requestView('normal');
}

/**
 * 툴바 "스케치": 고른 기준 평면 → 그 평면, 고른 객체 → 그 객체의 첫 면(윗면·끝 면), 아무것도 없으면 평면 고르기.
 */
export function startSketch() {
  const ed = useEditorStore.getState();
  const scene = useSceneStore.getState();
  ed.setPending(null);
  if (ed.selectedPlane) return startSketchOnPlane(ed.selectedPlane);
  const obj = selectSelectedObject(scene);
  const model = selectModel(scene);
  const face = obj ? facesOf(model, obj)[0] : undefined;
  if (obj && face) {
    const r = scene.submitNow({ type: 'create_sketch', id: nextId(model, 'sketch'), plane: { type: 'face', object: obj.id, face, offset: 0 } });
    if (r.status === 'applied') ed.requestView('normal');
    return;
  }
  ed.setPickingPlane(true);
  ed.requestView('iso'); // 세 평면이 모두 보이게
}

/**
 * 툴바 "돌출 보스/베이스"·"회전 보스/베이스": 선택한 스케치의 첫(사용 가능한) 프로파일로 속성 관리자를 연다.
 * 스케치가 없으면 이유를 상태바에.
 */
export function startFeature(kind: PendingFeature['kind']) {
  const scene = useSceneStore.getState();
  const sketch = selectSelectedSketch(scene);
  if (!sketch) {
    scene.reportError(`${kind === 'extrude' ? '돌출' : '회전'}할 스케치를 먼저 고르세요 (왼쪽 피처 트리에서 스케치를 클릭)`);
    return;
  }
  const usable = sketch.entities.filter((e) => {
    const p = resolveProfile(sketch, e.id);
    return p && (kind === 'extrude' || !revolveProfileError(p));
  });
  if (!usable.length) {
    scene.reportError(
      kind === 'extrude'
        ? `'${sketch.name}'에 돌출할 수 있는 도형이 없습니다 (사각형·원·다각형을 먼저 그리세요)`
        : `'${sketch.name}'에 회전할 수 있는 도형이 없습니다 (회전축 u = 0 의 한쪽에 있는 도형이 필요합니다)`,
    );
    return;
  }
  const profile = usable[0]!.id;
  useEditorStore.getState().setPending(
    kind === 'extrude' ? { kind, sketch: sketch.id, profile, distance: 10 } : { kind, sketch: sketch.id, profile, angle: 360 },
  );
  // 스케치에 수직인 보기에서는 두께가 안 보인다 → 등각 보기로 미리보기 전체를 보여 준다 (솔리드웍스와 같은 동작)
  useEditorStore.getState().requestView('iso');
}
