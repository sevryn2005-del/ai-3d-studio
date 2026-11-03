import { useEffect, useState } from 'react';
import type { CadObject, DimensionKind, FaceName, ModelDefinition, Point2, Sketch, SketchEntity, SketchPlane, StandardPlane } from '../../cad/commandTypes';
import { FACE_LABEL, PLANE_LABEL, facesOf, planeAxes } from '../../cad/sketchPlane';
import { useSceneStore } from '../../cad/sceneStore';
import { REQUIRED_DIMENSIONS, dimensionValue, findSketch, resolveProfile } from '../../cad/sketch';
import { throughHoleCommands } from '../../cad/sketchActions';
import { NumberField } from './NumberField';

/** 평면의 u·v 가 가리키는 축 이름 (sketchPlane.ts 규약, 면 평면은 u·v) */
const dimLabel = (kind: DimensionKind, plane: SketchPlane) =>
  kind === 'diameter' ? '지름' : kind === 'width' ? `폭 (${planeAxes(plane)[0]})` : `높이 (${planeAxes(plane)[1]})`;
const ENTITY_LABEL: Record<SketchEntity['type'], string> = { rectangle: '사각형', circle: '원' };

/**
 * 스케치 요소 하나의 치수·중심 입력. 바꾸면 set_dimension / set_entity_center 1건
 * (이 스케치를 쓰는 돌출이 모두 다시 계산됨)
 */
function EntityDimensions({ sketch, entity }: { sketch: Sketch; entity: SketchEntity }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const setCenter = (axis: 0 | 1) => (v: number) => {
    const center: Point2 = [...entity.center];
    center[axis] = v;
    submitNow({ type: 'set_entity_center', sketch: sketch.id, entity: entity.id, center });
  };
  return (
    <>
      {REQUIRED_DIMENSIONS[entity.type].map((kind) => (
        <NumberField
          key={kind}
          label={dimLabel(kind, sketch.plane)}
          unit="mm"
          value={dimensionValue(sketch, entity.id, kind) ?? 0}
          onCommit={(v) => submitNow({ type: 'set_dimension', sketch: sketch.id, dimension: `${entity.id}.${kind}`, value: v })}
          testId={`dim-${entity.id}.${kind}`}
        />
      ))}
      <NumberField label={`중심 ${planeAxes(sketch.plane)[0]}`} unit="mm" value={entity.center[0]} onCommit={setCenter(0)} testId={`center-${entity.id}-x`} />
      <NumberField label={`중심 ${planeAxes(sketch.plane)[1]}`} unit="mm" value={entity.center[1]} onCommit={setCenter(1)} testId={`center-${entity.id}-y`} />
    </>
  );
}

/** 선택한 스케치: 평면, 요소별 치수, 돌출 */
export function SketchProperties({ sketch, model }: { sketch: Sketch; model: ModelDefinition }) {
  const select = useSceneStore((s) => s.select);
  const submitNow = useSceneStore((s) => s.submitNow);
  const users = model.objects.filter((o) => o.kind === 'extrude' && o.extrude.sketch === sketch.id);
  const [name, setName] = useState(sketch.name);
  useEffect(() => setName(sketch.name), [sketch.name]);
  const usersOf = (entityId: string) => users.filter((o) => o.kind === 'extrude' && o.extrude.profile === entityId);
  const nextEntity = (prefix: string) => {
    let n = 1;
    while (sketch.entities.some((e) => e.id === `${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };
  return (
    <div className="props" data-testid="sketch-properties">
      <div className="field">
        <label htmlFor="sketch-name">이름</label>
        <input
          id="sketch-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name !== sketch.name ? submitNow({ type: 'rename_sketch', sketch: sketch.id, name }) : setName(sketch.name)
          }
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div className="muted small">
        ID: {sketch.id} · 유형: 스케치
      </div>
      <fieldset>
        <legend>평면</legend>
        <div className="field">
          <label htmlFor="sketch-plane">평면</label>
          <select
            id="sketch-plane"
            data-testid="sketch-plane"
            value={sketch.plane.type}
            onChange={(e) =>
              e.target.value !== 'face' &&
              submitNow({
                type: 'set_sketch_plane',
                sketch: sketch.id,
                plane: { type: e.target.value as StandardPlane['type'], offset: sketch.plane.offset },
              })
            }
          >
            {sketch.plane.type === 'face' && (
              <option value="face">
                {model.objects.find((o) => o.id === (sketch.plane as { object: string }).object)?.name ?? sketch.plane.object}의{' '}
                {FACE_LABEL[sketch.plane.face]}
              </option>
            )}
            {(Object.keys(PLANE_LABEL) as StandardPlane['type'][]).map((t) => (
              <option key={t} value={t}>
                {PLANE_LABEL[t]}
              </option>
            ))}
          </select>
        </div>
        <NumberField
          label="거리"
          unit="mm"
          value={sketch.plane.offset}
          onCommit={(v) => submitNow({ type: 'set_sketch_plane', sketch: sketch.id, plane: { ...sketch.plane, offset: v } })}
          testId="sketch-plane-offset"
        />
      </fieldset>
      {sketch.entities.map((e) => (
        <fieldset key={e.id}>
          <legend>
            {ENTITY_LABEL[e.type]} {e.id}
          </legend>
          <EntityDimensions sketch={sketch} entity={e} />
          <ExtrudeAction sketch={sketch} entityId={e.id} />
          <button
            className="danger"
            data-testid={`delete-entity-${e.id}`}
            disabled={usersOf(e.id).length > 0}
            title={usersOf(e.id).length ? `돌출(${usersOf(e.id).map((o) => o.name).join(', ')})이 쓰고 있어 지울 수 없습니다` : undefined}
            onClick={() => submitNow({ type: 'delete_sketch_entity', sketch: sketch.id, entity: e.id })}
          >
            {ENTITY_LABEL[e.type]} 삭제
          </button>
        </fieldset>
      ))}
      <div className="row">
        <button onClick={() => submitNow({ type: 'add_rectangle', sketch: sketch.id, id: nextEntity('r'), width: 20, height: 20 })}>
          + 사각형
        </button>
        <button onClick={() => submitNow({ type: 'add_circle', sketch: sketch.id, id: nextEntity('c'), diameter: 10 })}>+ 원</button>
      </div>
      {users.length > 0 && (
        <fieldset>
          <legend>이 스케치를 쓰는 돌출</legend>
          <div className="operands">
            {users.map((o) => (
              <button key={o.id} onClick={() => select(o.id)}>
                {o.name}
              </button>
            ))}
          </div>
        </fieldset>
      )}
      <button
        className="danger"
        data-testid="delete-sketch"
        disabled={users.length > 0}
        title={users.length ? '이 스케치를 쓰는 돌출 객체를 먼저 삭제하세요' : undefined}
        onClick={() => submitNow({ type: 'delete_sketch', sketch: sketch.id })}
      >
        스케치 삭제
      </button>
    </div>
  );
}

function ExtrudeAction({ sketch, entityId }: { sketch: Sketch; entityId: string }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const [distance, setDistance] = useState(4);
  return (
    <>
      <NumberField label="거리 (−: 안쪽)" unit="mm" value={distance} onCommit={setDistance} testId={`extrude-distance-${entityId}`} />
      <button
        data-testid={`extrude-${entityId}`}
        disabled={!resolveProfile(sketch, entityId)}
        onClick={() => submitNow({ type: 'extrude', sketch: sketch.id, profile: entityId, distance })}
      >
        돌출
      </button>
    </>
  );
}

/** 돌출 객체: 원본 스케치 윤곽 치수(직접 수정) + 관통 구멍 */
export function ExtrudeFields({ object, model }: { object: Extract<CadObject, { kind: 'extrude' }>; model: ModelDefinition }) {
  const select = useSceneStore((s) => s.select);
  const sketch = findSketch(model, object.extrude.sketch);
  const entity = sketch?.entities.find((e) => e.id === object.extrude.profile);
  if (!sketch || !entity) return <p className="muted small">원본 스케치를 찾을 수 없습니다: {object.extrude.sketch}</p>;
  return (
    <>
      <fieldset>
        <legend>윤곽 ({sketch.name})</legend>
        <EntityDimensions sketch={sketch} entity={entity} />
        <button onClick={() => select(sketch.id)} title="원본 스케치를 선택합니다">
          스케치 열기
        </button>
      </fieldset>
      <HoleAction object={object} model={model} />
    </>
  );
}

function HoleAction({ object, model }: { object: Extract<CadObject, { kind: 'extrude' }>; model: ModelDefinition }) {
  const dispatchBatch = useSceneStore((s) => s.dispatchBatch);
  const sketch = findSketch(model, object.extrude.sketch);
  const profile = sketch ? resolveProfile(sketch, object.extrude.profile) : null;
  const [diameter, setDiameter] = useState(6);
  const [center, setCenter] = useState<Point2 | null>(null);
  if (!profile) return null;
  const c: Point2 = center ?? profile.center;
  const plan = throughHoleCommands(model, object.id, { center: c, diameter });
  return (
    <fieldset>
      <legend>관통 구멍</legend>
      <NumberField label="지름" unit="mm" value={diameter} onCommit={setDiameter} testId="hole-diameter" />
      <NumberField label={`중심 ${planeAxes(profile.plane)[0]}`} unit="mm" value={c[0]} onCommit={(v) => setCenter([v, c[1]])} testId="hole-x" />
      <NumberField label={`중심 ${planeAxes(profile.plane)[1]}`} unit="mm" value={c[1]} onCommit={(v) => setCenter([c[0], v])} testId="hole-y" />
      {!plan.ok && <div className="muted small">{plan.error}</div>}
      <button data-testid="hole-apply" disabled={!plan.ok} onClick={() => plan.ok && dispatchBatch(plan.commands)}>
        구멍 뚫기
      </button>
    </fieldset>
  );
}

/**
 * 객체의 이름 있는 면에 새 스케치 (docs/design-face-sketch.md). 만든 스케치가 선택되고,
 * 뷰포트 그리기(R·C)나 "+ 사각형/+ 원" 으로 도형을 넣은 뒤 돌출한다. 객체가 움직이거나 치수가 바뀌면 따라간다.
 */
export function FaceSketchAction({ object, model }: { object: CadObject; model: ModelDefinition }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const faces = facesOf(model, object);
  const [face, setFace] = useState<FaceName | ''>('');
  const chosen = face && faces.includes(face) ? face : faces[0];
  if (!chosen) return null;
  return (
    <fieldset>
      <legend>이 면에 스케치</legend>
      <div className="field">
        <label htmlFor="face-pick">면</label>
        <select id="face-pick" data-testid="face-pick" value={chosen} onChange={(e) => setFace(e.target.value as FaceName)}>
          {faces.map((f) => (
            <option key={f} value={f}>
              {FACE_LABEL[f]}
            </option>
          ))}
        </select>
      </div>
      <button
        data-testid="face-sketch"
        onClick={() =>
          submitNow({
            type: 'create_sketch',
            name: `${object.name} ${FACE_LABEL[chosen].split(' ')[0]} 스케치`,
            plane: { type: 'face', object: object.id, face: chosen, offset: 0 },
          })
        }
      >
        스케치 만들기
      </button>
    </fieldset>
  );
}
