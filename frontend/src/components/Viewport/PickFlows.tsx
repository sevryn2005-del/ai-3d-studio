/**
 * 면·모서리 고르기 흐름 (형식 v12): 필렛 모서리, 메이트 면·축, 면 위 스케치, 면·모서리 측정.
 * 고른 것은 모두 명령(set_edge_feature·add_mate·create_sketch)으로 바뀐다 — 직접 수정과 AI 가 같은 경로.
 */
import { Matrix4 } from 'three';
import { create } from 'zustand';
import type { CadObject, MateRef } from '../../cad/commandTypes';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { topLevelObjects, byId } from '../../cad/modelGraph';
import { isSuppressed } from '../../cad/features';
import { objectWorldMatrix } from '../../cad/sketchPlane';
import { formatMm } from '../../cad/units';
import { useProjectStore } from '../../features/projects/projectStore';
import { edgesAt, faceToMateRef, faceToSketchPlane, measureEntities, usePickStore, type MeasureLine, type PickedEntity } from '../../features/selection/pick';

const visibleRoots = () => {
  const model = selectModel(useSceneStore.getState());
  const index = byId(model);
  return topLevelObjects(model).filter((o) => !o.hidden && !isSuppressed(o, index)).map((o) => o.id);
};
const round = (v: readonly number[]) => v.map((c) => Math.round(c * 1e6) / 1e6 + 0) as [number, number, number];

/** 필렛·모따기 모서리 고르기: 원본 형상의 모서리를 클릭해 켜고 끈 뒤 적용 → edges.at = 모서리 가운데 점들 */
export function startEdgePick(fillet: Extract<CadObject, { kind: 'fillet' }>) {
  const current = typeof fillet.fillet.edges === 'string' ? [] : fillet.fillet.edges.at;
  usePickStore.getState().start({
    purpose: 'fillet',
    accept: 'edge',
    objects: [fillet.fillet.source],
    frame: fillet.id,
    max: 200,
    hint: `${fillet.fillet.type === 'fillet' ? '필렛' : '모따기'}할 모서리를 클릭하세요 (다시 클릭하면 뺌)`,
    preselect: (_id, edges) => (current.length ? edgesAt(edges, current) : []),
    onDone: (picks) => {
      useSceneStore.getState().submitNow({ type: 'set_edge_feature', target: fillet.id, edges: { at: picks.map((p) => round(p.edge!.mid)) } });
    },
  });
}

/** 메이트 참조 고르기: 평면 = 면, 원통·원뿔면 = 축 */
export function startMatePick(onRef: (ref: MateRef) => void) {
  usePickStore.getState().start({
    purpose: 'mate',
    accept: 'face',
    objects: visibleRoots(),
    max: 1,
    hint: '메이트할 면(평면) 또는 원통면(축)을 클릭하세요',
    filter: (p) => (p.face && ['plane', 'cylinder', 'cone'].includes(p.face.kind) ? null : '평면·원통면만'),
    onDone: ([p]) => {
      const ref = faceToMateRef(selectModel(useSceneStore.getState()), p!.objectId, p!.face!);
      if (ref) onRef(ref);
    },
  });
}

/** 면 위에 스케치: 이름 있는 면 = 면 평면(객체를 따라감), 아니면 고른 면 평면(고정) */
export function startSketchOnFace() {
  usePickStore.getState().start({
    purpose: 'sketch',
    accept: 'face',
    objects: visibleRoots(),
    max: 1,
    hint: '스케치할 평면을 클릭하세요',
    filter: (p) => (p.face?.kind === 'plane' ? null : '평면만'),
    onDone: ([p]) => {
      const scene = useSceneStore.getState();
      const plane = faceToSketchPlane(selectModel(scene), p!.objectId, p!.face!, new Matrix4());
      if (!plane) return;
      const r = scene.submitNow({ type: 'create_sketch', plane });
      if (r.status === 'applied' && plane.type === 'frame') useProjectStore.getState().set({ notice: '고른 면에 이름이 없어 고정 위치 평면으로 만들었습니다 (객체를 옮겨도 따라가지 않음)' });
    },
  });
}

/** 고른 면 위의 한 점 (첫 삼각형 무게중심 — 면 안쪽, 위상 좌표계 = 월드) */
function pointOnFace(p: PickedEntity): [number, number, number] {
  const f = p.face!;
  const i = [f.indices[0]!, f.indices[1]!, f.indices[2]!];
  return round([0, 1, 2].map((k) => (f.positions[i[0]! * 3 + k]! + f.positions[i[1]! * 3 + k]! + f.positions[i[2]! * 3 + k]!) / 3));
}

/**
 * 면 이동 (형식 v39): 평면을 클릭 → 그 최상위 객체를 감싸는 면 이동(거리 5mm 밀기). patternId 가 있으면 그 면 이동의 면만 다시 고른다
 */
export function startMoveFacePick(patternId?: string) {
  const model = selectModel(useSceneStore.getState());
  const existing = patternId ? model.objects.find((o) => o.id === patternId) : undefined;
  const source = existing?.kind === 'pattern' ? existing.pattern.source : undefined;
  usePickStore.getState().start({
    purpose: 'moveFace',
    accept: 'face',
    objects: source ? [source] : visibleRoots(),
    ...(existing ? { frame: existing.id } : {}),
    max: 1,
    hint: '밀거나 당길 평면을 클릭하세요',
    filter: (p) => (p.face?.kind === 'plane' ? null : '평면만'),
    onDone: ([p]) => {
      const scene = useSceneStore.getState();
      const at = pointOnFace(p!);
      if (existing?.kind === 'pattern' && existing.pattern.type === 'face') scene.submitNow({ type: 'set_pattern', target: existing.id, pattern: { ...existing.pattern, at } });
      else scene.submitNow({ type: 'pattern', pattern: { type: 'face', source: p!.objectId, at, distance: 5 } });
    },
  });
}

/** 돔 (형식 v40): 평면 클릭 → 그 최상위 객체에 높이 5 돔. patternId 가 있으면 그 돔의 면만 다시 고른다 */
export function startDomePick(patternId?: string) {
  const model = selectModel(useSceneStore.getState());
  const existing = patternId ? model.objects.find((o) => o.id === patternId) : undefined;
  const source = existing?.kind === 'pattern' ? existing.pattern.source : undefined;
  usePickStore.getState().start({
    purpose: 'moveFace',
    accept: 'face',
    objects: source ? [source] : visibleRoots(),
    ...(existing ? { frame: existing.id } : {}),
    max: 1,
    hint: '돔을 올릴 평면을 클릭하세요',
    filter: (p) => (p.face?.kind === 'plane' ? null : '평면만'),
    onDone: ([p]) => {
      const scene = useSceneStore.getState();
      const at = pointOnFace(p!);
      if (existing?.kind === 'pattern' && existing.pattern.type === 'dome') scene.submitNow({ type: 'set_pattern', target: existing.id, pattern: { ...existing.pattern, at } });
      else scene.submitNow({ type: 'pattern', pattern: { type: 'dome', source: p!.objectId, at, height: 5 } });
    },
  });
}

interface MeasureState {
  lines: MeasureLine[] | null;
  set: (lines: MeasureLine[] | null) => void;
}
export const useEntityMeasure = create<MeasureState>((set) => ({ lines: null, set: (lines) => set({ lines }) }));

/** 면·모서리 측정: 한두 개를 고르고 적용(Enter) */
export function startMeasurePick() {
  useEntityMeasure.getState().set(null);
  usePickStore.getState().start({
    purpose: 'measure',
    accept: 'any',
    objects: visibleRoots(),
    max: 2,
    hint: '잴 면·모서리를 한두 개 클릭하세요 (모서리 = 길이·지름, 두 개 = 거리·각도)',
    onDone: (picks) => useEntityMeasure.getState().set(measureEntities(picks)),
  });
}

export function MeasureEntityPanel() {
  const lines = useEntityMeasure((s) => s.lines);
  if (!lines) return null;
  return (
    <div className="view-panel mass-panel measure-entity-panel" role="dialog" aria-label="면·모서리 측정" data-testid="measure-entity-panel">
      <div className="pm-head">
        <strong>면·모서리 측정</strong>
      </div>
      {lines.length === 0 && <p className="muted small">이 요소들로는 잴 값이 없습니다</p>}
      <dl className="mass-list">
        {lines.map((l) => (
          <div key={l.label}>
            <dt>{l.label}</dt>
            <dd data-testid={`measure-${l.label}`}>
              {formatMm(Math.round(l.value * 1000) / 1000)} {l.unit}
            </dd>
          </div>
        ))}
      </dl>
      <div className="row">
        <button onClick={startMeasurePick}>다시 재기</button>
        <button className="cancel" onClick={() => useEntityMeasure.getState().set(null)}>
          ✕ 닫기
        </button>
      </div>
    </div>
  );
}

/** 필렛 원본의 월드 행렬 (테스트·표시용) */
export const filletFrame = (id: string) => objectWorldMatrix(selectModel(useSceneStore.getState()), id);
