/**
 * 솔리드웍스식 피처 흐름의 동작 (툴바·속성 관리자·뷰포트·단축키 공용).
 * 모든 변경은 명령(submitNow)으로만 — 미리보기·취소는 편집기 상태(editorStore)만 바꾼다.
 */
import type { CadCommand, StandardPlane } from '../../cad/commandTypes';
import { nextId } from '../../cad/commandExecutor';
import { selectModel, selectSelectedObject, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { resolveProfile, revolveProfileError } from '../../cad/sketch';
import { facesOf, objectWorldMatrix } from '../../cad/sketchPlane';
import { fromMatrix } from '../../cad/transformMath';
import { childIds, topLevelObjects } from '../../cad/modelGraph';
import { localSize } from '../../cad/objectKinds';
import { helixError, helixProfilePoints } from '../../cad/sections';
import { parseObj, parseStl, prepareImport, toBase64 } from '../../cad/meshData';
import { pickFileWithInput } from '../projects/projectStorage';
import { useProjectStore } from '../projects/projectStore';
import { useEditorStore, type PendingFeature } from './editorStore';

export function pendingCommand(p: PendingFeature): CadCommand {
  return p.kind === 'extrude'
    ? { type: 'extrude', sketch: p.sketch, profile: p.profile, distance: p.distance }
    : { type: 'revolve', sketch: p.sketch, profile: p.profile, angle: p.angle };
}

/**
 * 확인(✓): 명령 1건(컷이면 피처 + 빼기 2건을 한 묶음 = 실행 취소 1번)으로 확정.
 * 거부되면 속성 관리자를 그대로 두고 이유는 상태바에
 */
export function commitPending(): boolean {
  const ed = useEditorStore.getState();
  const p = ed.pending;
  if (!p) return false;
  const scene = useSceneStore.getState();
  if (p.cutTarget) {
    const id = nextId(selectModel(scene), p.kind);
    const r = scene.dispatchBatch([{ ...pendingCommand(p), id }, { type: 'cut', base: p.cutTarget, tools: [id] }]);
    if (r.ok) ed.setPending(null);
    return r.ok;
  }
  const r = scene.submitNow(pendingCommand(p));
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
export function startFeature(kind: PendingFeature['kind'], cut = false) {
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
  // 컷: 면 위 스케치면 그 면의 (최상위) 바디, 아니면 첫 최상위 바디에서 뺀다. 음수 돌출(면 안쪽)이 기본
  let cutTarget: string | undefined;
  if (cut) {
    const model = selectModel(scene);
    const parents = new Map(model.objects.flatMap((o) => childIds(o).map((c) => [c, o.id] as const)));
    let anchor = sketch.plane.type === 'face' ? sketch.plane.object : topLevelObjects(model)[0]?.id;
    while (anchor && parents.has(anchor)) anchor = parents.get(anchor);
    if (!anchor) {
      scene.reportError('뺄 바디가 없습니다. 먼저 형상을 만드세요');
      return;
    }
    cutTarget = anchor;
  }
  const distance = cut && sketch.plane.type === 'face' ? -10 : 10;
  useEditorStore.getState().setPending(
    kind === 'extrude'
      ? { kind, sketch: sketch.id, profile, distance, ...(cutTarget ? { cutTarget } : {}) }
      : { kind, sketch: sketch.id, profile, angle: 360, ...(cutTarget ? { cutTarget } : {}) },
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

/**
 * 모서리 필렛·모따기 (형식 v9, 정밀 엔진): 선택한 최상위 객체의 모든 모서리를 가장 얇은 치수의 1/10 (0.5~2mm).
 * 속성 관리자에서 크기·모서리 규칙(전체·세로·위·아래)을 바꾼다
 */
export function quickEdgeFeature(feature: 'fillet' | 'chamfer') {
  const s = selectedRoot(feature === 'fillet' ? '필렛' : '모따기');
  if (!s) return;
  const { scene, obj, model } = s;
  const thin = Math.min(...localSize(obj, model).map(Math.abs).filter((v) => v > 0));
  const size = Math.max(0.5, Math.min(2, Math.round((thin / 10) * 10) / 10));
  scene.submitNow({ type: 'edge_feature', target: obj.id, feature, size, edges: 'all' });
}

/** 구배: 선택한 최상위 객체의 옆면을 바닥 기준 3° (위로 갈수록 좁게) */
export function quickDraft() {
  const s = selectedRoot('구배');
  if (!s) return;
  s.scene.submitNow({ type: 'draft', target: s.obj.id, angle: 3 });
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

/** 크기 조정: 선택한 객체를 원점 기준 1.5배 (속성에서 축별 배율 조정) */
export function quickScale() {
  const s = selectedRoot('크기 조정');
  if (!s) return;
  s.scene.submitNow({ type: 'pattern', pattern: { type: 'scale', source: s.obj.id, x: 1.5, y: 1.5, z: 1.5 } });
}

function selectedSketchFor(action: string) {
  const scene = useSceneStore.getState();
  const sketch = selectSelectedSketch(scene);
  if (!sketch) scene.reportError(`${action}: 스케치를 먼저 고르세요 (피처 트리에서 스케치를 클릭하거나 "스케치" 로 새로 만들기)`);
  return sketch ? { scene, sketch } : null;
}

/** 슬롯 추가: 원점에 길이 20·폭 8 (속성에서 치수·위치·방향 조정) */
export function quickSlot() {
  const s = selectedSketchFor('슬롯');
  if (s) s.scene.submitNow({ type: 'add_slot', sketch: s.sketch.id, center: [0, 0], length: 20, width: 8 });
}

/** 구성선 추가: u 축 위 −20 ~ 20 (구속 기준선) */
export function quickLine() {
  const s = selectedSketchFor('구성선');
  if (s) s.scene.submitNow({ type: 'add_line', sketch: s.sketch.id, points: [[-20, 0], [20, 0]] });
}

/** 헬릭스: 선택한 스케치의 첫 프로파일(축 한쪽)로, 피치 = 프로파일 높이 + 2mm, 5바퀴 */
export function quickHelix() {
  const s = selectedSketchFor('헬릭스');
  if (!s) return;
  const { scene, sketch } = s;
  for (const e of sketch.entities) {
    const p = resolveProfile(sketch, e.id);
    if (!p) continue;
    const pts = helixProfilePoints(p, 0.05);
    const h = Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]));
    const pitch = Math.round((h + 2) * 10) / 10;
    if (helixError(pts, pitch)) continue;
    scene.submitNow({ type: 'helix', sketch: sketch.id, profile: e.id, pitch, turns: 5 });
    useEditorStore.getState().requestView('iso');
    return;
  }
  scene.reportError(`헬릭스: '${sketch.name}'에 회전축(u = 0) 한쪽에 있는 단면이 없습니다 (XZ 평면에 u > 0 쪽으로 그리세요)`);
}

/**
 * 나사산 (솔리드웍스 "나사산", 블렌더 Screw): 선택한 원통 둘레에 60° 삼각 나사산(피치 p, 산 높이 0.6p)을
 * 헬릭스로 감아 원통과 합친다. 명령 한 묶음 = 실행 취소 1번
 */
export function quickThread(pitch = 1.5) {
  const s = selectedRoot('나사산');
  if (!s) return;
  const { scene, obj, model } = s;
  if (obj.kind !== 'cylinder') {
    scene.reportError('나사산: 원통을 선택하세요 (볼트 몸통)');
    return;
  }
  const r = obj.params.radius;
  const h = obj.params.height;
  const depth = Math.round(0.6 * pitch * 1000) / 1000;
  const turns = Math.floor(((h - pitch) / pitch) * 10) / 10;
  if (turns < 0.5) {
    scene.reportError('나사산: 원통이 피치보다 충분히 길어야 합니다');
    return;
  }
  const sk = nextId(model, 'sketch');
  const hx = nextId(model, 'helix');
  const r0 = Math.round((r - 0.05) * 1000) / 1000; // 원통 안쪽으로 살짝 겹쳐 합치기가 확실하게
  scene.dispatchBatch([
    { type: 'create_sketch', id: sk, name: `${obj.name} 나사산 단면`, plane: { type: 'XZ', offset: 0 } },
    { type: 'add_polygon', sketch: sk, id: 'thread', points: [[r0, 0.05 * pitch], [r + depth, pitch / 2], [r0, 0.95 * pitch]] },
    { type: 'helix', id: hx, name: '나사산', sketch: sk, profile: 'thread', pitch, turns },
    { type: 'set_transform', target: hx, position: obj.transform.position, rotation: obj.transform.rotation },
    { type: 'union', base: obj.id, tools: [hx], name: `${obj.name} (나사)` },
  ]);
}

/** 로프트 단면 고르기 창 열기 (스케치가 2개 이상이어야) */
export function openLoft() {
  const scene = useSceneStore.getState();
  const model = selectModel(scene);
  const usable = model.sketches.filter((sk) => sk.entities.some((e) => resolveProfile(sk, e.id)));
  if (usable.length < 2) {
    scene.reportError('로프트: 단면이 있는 스케치가 2개 이상 필요합니다 (예: 높이가 다른 XY 평면 두 개에 사각형·원)');
    return;
  }
  useEditorStore.getState().setLoftOpen(true);
}

/** STL·OBJ 가져오기 → 원점 규칙(바닥면 중심)에 맞춰 메시 객체 */
/** STEP 파일 최대 크기: 저장 형식(base64 1,600만 자) 한도 */
export const MAX_STEP_BYTES = 12_000_000;

export async function importMeshFile() {
  let file: File;
  try {
    file = await pickFileWithInput('.stl,.obj,.step,.stp,model/stl,model/step,text/plain');
  } catch {
    return;
  }
  const scene = useSceneStore.getState();
  if (/\.(step|stp)$/i.test(file.name)) {
    // STEP: 정확한 곡면 그대로 저장하고 정밀 엔진(OCCT)이 읽는다. 원점은 엔진이 바닥면 중심으로 맞춘다
    if (file.size > MAX_STEP_BYTES) {
      scene.reportError(`가져오기 실패: STEP 파일은 ${MAX_STEP_BYTES / 1_000_000}MB 까지 가져올 수 있습니다`);
      return;
    }
    const name = file.name.replace(/\.(step|stp)$/i, '').slice(0, 100) || '가져온 STEP';
    const res = scene.submitNow({ type: 'import_step', name, data: toBase64(new Uint8Array(await file.arrayBuffer())) });
    if (res.status === 'applied') {
      useProjectStore.getState().set({ notice: `${file.name}: STEP (정밀 엔진으로 계산)` });
      useEditorStore.getState().requestFit();
    }
    return;
  }
  try {
    const isObj = file.name.toLowerCase().endsWith('.obj');
    const soup = isObj ? parseObj(await file.text()) : parseStl(await file.arrayBuffer());
    let r = prepareImport(soup);
    // 크기가 1mm 미만이면 미터 단위로 저장된 파일(블렌더 기본) → mm 로
    const meters = Math.max(...r.size) < 1;
    if (meters) r = prepareImport(soup, 1000);
    const name = file.name.replace(/\.(stl|obj)$/i, '').slice(0, 100) || '가져온 메시';
    const res = scene.submitNow({ type: 'import_mesh', name, positions: r.positions, indices: r.indices });
    if (res.status === 'applied') {
      useProjectStore.getState().set({ notice: `${file.name}: 삼각형 ${r.triangles.toLocaleString()}개${meters ? ' (미터 → mm 로 1000배)' : ''}` });
      useEditorStore.getState().requestFit();
    }
  } catch (e) {
    scene.reportError(`가져오기 실패: ${(e as Error).message}`);
  }
}

/** ISO 보통 나사 피치 (호칭 지름 → 피치). 구멍 지름에 가장 가까운 호칭을 쓴다 */
const ISO_COARSE: [number, number][] = [[2, 0.4], [2.5, 0.45], [3, 0.5], [4, 0.7], [5, 0.8], [6, 1], [8, 1.25], [10, 1.5], [12, 1.75], [16, 2], [20, 2.5], [24, 3]];

/**
 * 암나사 (구멍 안쪽 나사산): 선택한 구멍(구멍 가공으로 만든 구멍 도구)의 벽에 60° 나사 홈을 헬릭스로 판다.
 * 구멍 지름 = 나사의 안지름으로 보고, 가장 가까운 ISO 보통 나사 피치를 쓴다. 명령 한 묶음 = 실행 취소 1번
 */
export function quickInternalThread() {
  const scene = useSceneStore.getState();
  const model = selectModel(scene);
  const obj = selectSelectedObject(scene);
  if (!obj || obj.kind !== 'hole') {
    scene.reportError('암나사: 피처 트리에서 구멍(구멍 가공으로 만든 "구멍 Ø…")을 선택하세요');
    return;
  }
  const parents = new Map(model.objects.flatMap((o) => childIds(o).map((c) => [c, o.id] as const)));
  let root = obj.id;
  while (parents.has(root)) root = parents.get(root)!;
  const d = obj.params.diameter;
  const pitch = ISO_COARSE.reduce((best, [nom, p]) => (Math.abs(nom - (d + 1.08 * p)) < Math.abs(best[0] - (d + 1.08 * best[1])) ? [nom, p] : best))[1];
  const r = d / 2;
  const depth = Math.round(0.6 * pitch * 1000) / 1000;
  const turns = Math.floor(((obj.params.depth - pitch) / pitch) * 10) / 10;
  if (turns < 0.5) {
    scene.reportError('암나사: 구멍이 피치보다 충분히 깊어야 합니다');
    return;
  }
  const world = fromMatrix(objectWorldMatrix(model, obj.id));
  const sk = nextId(model, 'sketch');
  const hx = nextId(model, 'helix');
  const r0 = Math.round((r - 0.05) * 1000) / 1000;
  scene.dispatchBatch([
    { type: 'create_sketch', id: sk, name: `${obj.name} 암나사 단면`, plane: { type: 'XZ', offset: 0 } },
    { type: 'add_polygon', sketch: sk, id: 'thread', points: [[r0, 0.05 * pitch], [r + depth, pitch / 2], [r0, 0.95 * pitch]] },
    { type: 'helix', id: hx, name: `암나사 P${pitch}`, sketch: sk, profile: 'thread', pitch, turns },
    { type: 'set_transform', target: hx, position: world.position, rotation: world.rotation },
    { type: 'cut', base: root, tools: [hx], name: `${model.objects.find((o) => o.id === root)?.name ?? root} (암나사)` },
  ]);
}
