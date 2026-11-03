/**
 * 솔리드웍스식 피처 흐름의 동작 (툴바·속성 관리자·뷰포트·단축키 공용).
 * 모든 변경은 명령(submitNow)으로만 — 미리보기·취소는 편집기 상태(editorStore)만 바꾼다.
 */
import type { CadCommand, StandardPlane } from '../../cad/commandTypes';
import { nextId } from '../../cad/commandExecutor';
import { selectModel, selectSelectedObject, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { resolveProfile, revolveProfileError } from '../../cad/sketch';
import { facesOf } from '../../cad/sketchPlane';
import { childIds } from '../../cad/modelGraph';
import { localSize } from '../../cad/objectKinds';
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

// ---- 피처 탭 빠른 명령 (선택한 최상위 객체에 기본값으로 적용 → 속성에서 값 조정) ----

function selectedRoot(action: string) {
  const scene = useSceneStore.getState();
  const obj = selectSelectedObject(scene);
  const model = selectModel(scene);
  if (!obj) {
    scene.reportError(`${action}: 먼저 객체를 선택하세요`);
    return null;
  }
  if (model.objects.some((o) => childIds(o).includes(obj.id))) {
    scene.reportError(`${action}: '${obj.name}'은(는) 다른 객체에 포함되어 있습니다. 상위 객체를 선택하세요`);
    return null;
  }
  return { scene, obj, model };
}

/** 쉘: 가장 얇은 치수의 1/5 (최대 2mm), 윗면(돌출은 끝면) 열기 */
export function quickShell() {
  const s = selectedRoot('쉘');
  if (!s) return;
  const { scene, obj, model } = s;
  if (obj.kind !== 'box' && obj.kind !== 'cylinder' && obj.kind !== 'extrude') {
    scene.reportError('쉘은 박스·원통·돌출에만 할 수 있습니다');
    return;
  }
  const size = localSize(obj, model);
  const t = Math.max(0.4, Math.min(2, Math.round((Math.min(...size.map(Math.abs).filter((v) => v > 0)) / 5) * 10) / 10));
  scene.submitNow({ type: 'shell', target: obj.id, thickness: t, open: [obj.kind === 'extrude' ? 'end' : 'top'] });
}

/** 패턴·대칭: 선형 = X 방향 3개 (크기 + 5mm 간격), 원형 = Z축 6개, 대칭 = YZ 평면 */
export function quickPattern(type: 'linear' | 'circular' | 'mirror') {
  const s = selectedRoot(type === 'mirror' ? '대칭 복사' : '패턴');
  if (!s) return;
  const { scene, obj, model } = s;
  const step = Math.round(Math.abs(localSize(obj, model)[0]) + 5);
  const pattern =
    type === 'linear'
      ? ({ type, source: obj.id, axis: 'x', count: 3, spacing: step } as const)
      : type === 'circular'
        ? ({ type, source: obj.id, axis: 'z', count: 6, angle: 360 } as const)
        : ({ type, source: obj.id, plane: 'YZ', offset: 0 } as const);
  scene.submitNow({ type: 'pattern', pattern });
}

/** 구멍: 첫 면(윗면) 중심에 지름 5mm, 객체 높이만큼 (관통) */
export function quickHole() {
  const s = selectedRoot('구멍 가공');
  if (!s) return;
  const { scene, obj, model } = s;
  const face = facesOf(model, obj)[0];
  if (!face) {
    scene.reportError(`구멍 가공: '${obj.name}'에는 구멍을 낼 수 있는 평평한 면이 없습니다`);
    return;
  }
  const depth = Math.max(1, Math.round(Math.abs(localSize(obj, model)[2]) * 10) / 10);
  scene.submitNow({ type: 'hole', target: obj.id, face, at: [0, 0], diameter: 5, depth });
}
