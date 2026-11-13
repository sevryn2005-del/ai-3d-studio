/**
 * 솔리드웍스식 면 → 스케치 흐름:
 * - 요소 변환 (Convert Entities): 스케치를 고른 채 면을 클릭 → 그 면의 윤곽(바깥 + 구멍)이 스케치 요소로 (cad/faceOutline.ts)
 * - 스케치 없이 돌출·컷: 면을 클릭하면 그 면에 스케치를 만들고 윤곽을 넣은 뒤 바로 돌출 확인 단계로
 * 결과는 보통의 명령 묶음 (create_sketch · add_polygon · add_circle · add_region) — 실행 취소 1번.
 */
import { Matrix4, Vector3 } from 'three';
import type { CadCommand, ObjectId, Sketch } from '../../cad/commandTypes';
import { executeBatch } from '../../cad/commandExecutor';
import { selectModel, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { byId, topLevelObjects } from '../../cad/modelGraph';
import { isSuppressed } from '../../cad/features';
import { sketchWorldMatrix } from '../../cad/sketchPlane';
import { convertCommands, faceLoops, projectLoops } from '../../cad/faceOutline';
import type { TopoFace } from '../engine/types';
import { faceToSketchPlane, usePickStore } from './pick';

const visibleRoots = () => {
  const model = selectModel(useSceneStore.getState());
  const index = byId(model);
  return topLevelObjects(model).filter((o) => !o.hidden && !isSuppressed(o, index)).map((o) => o.id);
};

/** 면 윤곽 → 이 스케치의 명령 (면이 스케치 평면과 평행해야 — 아니면 이유) */
function outlineFor(sketch: Sketch, sketchWorld: Matrix4, face: TopoFace): ReturnType<typeof convertCommands> {
  const n = new Vector3().setFromMatrixColumn(sketchWorld, 2).normalize();
  const fn = new Vector3(...face.dir).normalize();
  if (Math.abs(n.dot(fn)) < 0.999) return { ok: false, error: '스케치 평면과 평행한 면만 옮길 수 있습니다 (기울어진 면은 그 면에 새 스케치를 만드세요)' };
  return convertCommands(sketch, projectLoops(faceLoops(face.positions, face.indices), sketchWorld));
}

/** 요소 변환: 고른 스케치에 면 윤곽 넣기 */
export function startConvertEntities() {
  const scene = useSceneStore.getState();
  const sketch = selectSelectedSketch(scene);
  if (!sketch) return scene.reportError('요소 변환: 윤곽을 넣을 스케치를 먼저 고르세요 (피처 트리에서 스케치 클릭)');
  usePickStore.getState().start({
    purpose: 'sketch',
    accept: 'face',
    objects: visibleRoots(),
    max: 1,
    hint: '윤곽을 스케치로 옮길 평면을 클릭하세요 (바깥 윤곽과 구멍이 함께 들어옵니다)',
    filter: (p) => (p.face?.kind === 'plane' ? null : '평면만'),
    onDone: ([p]) => {
      const s = useSceneStore.getState();
      const model = selectModel(s);
      const sk = model.sketches.find((k) => k.id === sketch.id);
      const world = sk && sketchWorldMatrix(model, sk);
      if (!sk || !world) return s.reportError('요소 변환: 스케치 평면을 찾을 수 없습니다');
      const r = outlineFor(sk, world, p!.face!);
      if (!r.ok) return s.reportError(`요소 변환: ${r.error}`);
      if (s.dispatchBatch(r.commands).ok) s.select(sk.id);
    },
  });
}

/** 스케치 없이 돌출·컷·회전 시작: 면을 클릭 → 그 면에 윤곽 스케치 → then(스케치ID) */
export function startFaceSketchFeature(label: string, then: (sketchId: ObjectId) => void) {
  usePickStore.getState().start({
    purpose: 'sketch',
    accept: 'face',
    objects: visibleRoots(),
    max: 1,
    hint: `${label}할 평면을 클릭하세요 — 그 면 윤곽으로 스케치를 만듭니다 (또는 Esc 후 스케치를 고르세요)`,
    filter: (p) => (p.face?.kind === 'plane' ? null : '평면만'),
    onDone: ([p]) => {
      const s = useSceneStore.getState();
      const model = selectModel(s);
      const plane = faceToSketchPlane(model, p!.objectId, p!.face!, new Matrix4());
      if (!plane) return s.reportError(`${label}: 평면을 고르세요`);
      const taken = new Set([...model.objects.map((o) => o.id), ...model.sketches.map((k) => k.id)]);
      let k = model.sketches.length + 1;
      while (taken.has(`sketch_${k}`)) k++;
      const id = `sketch_${k}`;
      const create: CadCommand = { type: 'create_sketch', id, plane };
      const trial = executeBatch(model, [create]);
      if (!trial.ok) return s.reportError(trial.error);
      const sk = trial.model.sketches.find((x) => x.id === id)!;
      const world = sketchWorldMatrix(trial.model, sk);
      if (!world) return s.reportError(`${label}: 스케치 평면을 찾을 수 없습니다`);
      const r = outlineFor(sk, world, p!.face!);
      if (!r.ok) return s.reportError(`${label}: ${r.error}`);
      if (!s.dispatchBatch([create, ...r.commands]).ok) return;
      s.select(id);
      then(id);
    },
  });
}
