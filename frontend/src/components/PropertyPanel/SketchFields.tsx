import { useEffect, useState } from 'react';
import type { AngledPlane, CadObject, DimensionKind, FaceName, ModelDefinition, Point2, Sketch, SketchEntity, SketchPlane, StandardPlane } from '../../cad/commandTypes';
import { FACE_LABEL, PLANE_LABEL, facesOf, planeAxes } from '../../cad/sketchPlane';
import { useSceneStore } from '../../cad/sceneStore';
import { REQUIRED_DIMENSIONS, dimensionValue, findSketch, profileOf, regionUsers, resolveProfile, revolveProfileError, sketchRefs } from '../../cad/sketch';
import { throughHoleCommands } from '../../cad/sketchActions';
import { NumberField } from './NumberField';
import { ConstraintPanel, PolygonFields } from './ConstraintFields';

/** 평면의 u·v 가 가리키는 축 이름 (sketchPlane.ts 규약, 면 평면은 u·v) */
const dimLabel = (kind: DimensionKind, plane: SketchPlane, type?: SketchEntity['type']) =>
  kind === 'diameter' ? '지름'
  : kind === 'length' ? '길이 (반원 중심 사이)'
  : type === 'slot' && kind === 'width' ? '폭'
  : type === 'ellipse' ? (kind === 'width' ? '지름 (방향 축)' : '지름 (수직 축)')
  : kind === 'width' ? `폭 (${planeAxes(plane)[0]})` : `높이 (${planeAxes(plane)[1]})`;
export const ENTITY_LABEL: Record<SketchEntity['type'], string> = { rectangle: '사각형', circle: '원', polygon: '다각형', line: '구성선', slot: '슬롯', path: '경로', region: '영역', ellipse: '타원' };
const CLOSED = new Set<SketchEntity['type']>(['rectangle', 'circle', 'polygon', 'slot', 'ellipse']);

/**
 * 스케치 요소 하나의 치수·중심 입력. 바꾸면 set_dimension / set_entity_center 1건
 * (이 스케치를 쓰는 돌출이 모두 다시 계산됨)
 */
function EntityDimensions({ sketch, entity }: { sketch: Sketch; entity: SketchEntity }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  if (entity.type === 'polygon' || entity.type === 'path') return <PolygonFields sketch={sketch} polygon={entity} />;
  if (entity.type === 'region') return <RegionFields sketch={sketch} region={entity} />;
  if (entity.type === 'line') {
    const [u, v] = planeAxes(sketch.plane);
    const setPoint = (k: 0 | 1, axis: 0 | 1) => (val: number) => {
      const to: Point2 = [...entity.points[k]];
      to[axis] = val;
      submitNow({ type: 'move_point', sketch: sketch.id, point: `${entity.id}.p${k}`, to });
    };
    return (
      <>
        {([0, 1] as const).map((k) => (
          <div key={k} className="vertex-row">
            <NumberField label={`끝점 ${k + 1} ${u}`} unit="mm" value={entity.points[k][0]} onCommit={setPoint(k, 0)} testId={`line-${entity.id}-p${k}-x`} />
            <NumberField label={`끝점 ${k + 1} ${v}`} unit="mm" value={entity.points[k][1]} onCommit={setPoint(k, 1)} testId={`line-${entity.id}-p${k}-y`} />
          </div>
        ))}
        <p className="muted small">구성선은 형상을 만들지 않습니다. 구속(각도·평행·일치 등)의 기준으로 씁니다 ({entity.id}.e0, {entity.id}.p0, {entity.id}.p1).</p>
      </>
    );
  }
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
          label={dimLabel(kind, sketch.plane, entity.type)}
          unit="mm"
          value={dimensionValue(sketch, entity.id, kind) ?? 0}
          onCommit={(v) => submitNow({ type: 'set_dimension', sketch: sketch.id, dimension: `${entity.id}.${kind}`, value: v })}
          testId={`dim-${entity.id}.${kind}`}
        />
      ))}
      <NumberField label={`중심 ${planeAxes(sketch.plane)[0]}`} unit="mm" value={entity.center[0]} onCommit={setCenter(0)} testId={`center-${entity.id}-x`} />
      <NumberField label={`중심 ${planeAxes(sketch.plane)[1]}`} unit="mm" value={entity.center[1]} onCommit={setCenter(1)} testId={`center-${entity.id}-y`} />
      {entity.type === 'rectangle' && (
        <button
          onClick={() => submitNow({ type: 'convert_to_polygon', sketch: sketch.id, entity: entity.id })}
          data-testid={`to-polygon-${entity.id}`}
          title="같은 모양의 다각형으로 바꿉니다 — 꼭짓점 필렛·모따기, 변을 호로, 꼭짓점 이동을 쓸 수 있습니다"
        >
          다각형으로 바꾸기 (모서리 둥글게·호)
        </button>
      )}
      {(entity.type === 'slot' || entity.type === 'ellipse') && (
        <NumberField
          label="방향"
          unit="°"
          value={entity.angle}
          onCommit={(v) => submitNow({ type: 'set_entity_angle', sketch: sketch.id, entity: entity.id, angle: v })}
          testId={`angle-${entity.id}`}
        />
      )}
    </>
  );
}

/**
 * 영역 (형식 v15): 구성 요소를 순서대로 합치기(+)·빼기(−). 첫 요소는 합치기. 바꾸면 set_region 1건
 * (잘라내기 대신 — 구성 요소는 그대로 남아 치수를 고치면 영역이 따라 바뀐다)
 */
function RegionFields({ sketch, region }: { sketch: Sketch; region: Extract<SketchEntity, { type: 'region' }> }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const set = (items: typeof region.items) => submitNow({ type: 'set_region', sketch: sketch.id, entity: region.id, items });
  const free = sketch.entities.filter((e) => CLOSED.has(e.type) && !region.items.some((it) => it.entity === e.id));
  return (
    <div className="region-fields">
      <p className="muted small">구성 요소를 위에서부터 차례로 합치고(+) 뺍니다(−). 구성 요소의 치수·위치를 고치면 영역이 따라 바뀝니다.</p>
      <ol className="region-items">
        {region.items.map((it, k) => (
          <li key={it.entity} data-testid={`region-item-${it.entity}`}>
            <select
              aria-label={`${it.entity} 합치기/빼기`}
              value={it.op}
              disabled={k === 0}
              onChange={(e) => set(region.items.map((x) => (x.entity === it.entity ? { ...x, op: e.target.value as 'add' | 'subtract' } : x)))}
              data-testid={`region-op-${it.entity}`}
            >
              <option value="add">+ 합치기</option>
              <option value="subtract">− 빼기</option>
            </select>
            <span>
              {ENTITY_LABEL[sketch.entities.find((e) => e.id === it.entity)?.type ?? 'rectangle']} {it.entity}
            </span>
            <button
              className="cancel"
              title="영역에서 빼기 (요소는 남음)"
              disabled={region.items.length === 1}
              onClick={() => {
                const rest = region.items.filter((x) => x.entity !== it.entity);
                set(rest.map((x, i) => (i === 0 ? { ...x, op: 'add' } : x)));
              }}
              data-testid={`region-remove-${it.entity}`}
            >
              ✕
            </button>
          </li>
        ))}
      </ol>
      {free.length > 0 && (
        <select
          value=""
          aria-label="영역에 요소 넣기"
          onChange={(e) => e.target.value && set([...region.items, { entity: e.target.value, op: 'subtract' }])}
          data-testid={`region-add-${region.id}`}
        >
          <option value="">+ 요소 넣기 (빼기로)</option>
          {free.map((e) => (
            <option key={e.id} value={e.id}>
              {ENTITY_LABEL[e.type]} {e.id}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}

/** 선택한 스케치: 평면, 요소별 치수, 돌출 */
export function SketchProperties({ sketch, model }: { sketch: Sketch; model: ModelDefinition }) {
  const select = useSceneStore((s) => s.select);
  const submitNow = useSceneStore((s) => s.submitNow);
  const users = model.objects.filter((o) => sketchRefs(o).some((r) => r.sketch === sketch.id));
  const [name, setName] = useState(sketch.name);
  useEffect(() => setName(sketch.name), [sketch.name]);
  const usersOf = (entityId: string) => users.filter((o) => sketchRefs(o).some((r) => r.sketch === sketch.id && r.profile === entityId));
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
            onChange={(e) => {
              const v = e.target.value;
              if (v === 'face' || v === 'frame') return;
              const base: StandardPlane['type'] = sketch.plane.type === 'angled' ? sketch.plane.base : sketch.plane.type === 'face' || sketch.plane.type === 'frame' ? 'XY' : sketch.plane.type;
              submitNow({
                type: 'set_sketch_plane',
                sketch: sketch.id,
                plane: v === 'angled'
                  ? { type: 'angled', base, axis: 'u', angle: 30, offset: sketch.plane.offset }
                  : { type: v as StandardPlane['type'], offset: sketch.plane.offset },
              });
            }}
          >
            {sketch.plane.type === 'face' && (
              <option value="face">
                {model.objects.find((o) => o.id === (sketch.plane as { object: string }).object)?.name ?? sketch.plane.object}의{' '}
                {FACE_LABEL[sketch.plane.face]}
              </option>
            )}
            {sketch.plane.type === 'frame' && <option value="frame">고른 면 (고정 위치)</option>}
            {(Object.keys(PLANE_LABEL) as StandardPlane['type'][]).map((t) => (
              <option key={t} value={t}>
                {PLANE_LABEL[t]}
              </option>
            ))}
            <option value="angled">각도 평면 (기준 평면을 기울임)</option>
          </select>
        </div>
        {sketch.plane.type === 'angled' && (
          <AngledPlaneFields sketch={sketch} plane={sketch.plane} />
        )}
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
          {e.type !== 'line' && e.type !== 'region' && (
            <NumberField
              label="오프셋 복사 (+ 바깥, − 안쪽)"
              unit="mm"
              value={0}
              onCommit={(v) => v !== 0 && submitNow({ type: 'offset_entity', sketch: sketch.id, entity: e.id, distance: v })}
              testId={`offset-${e.id}`}
            />
          )}
          <button
            className="danger"
            data-testid={`delete-entity-${e.id}`}
            disabled={usersOf(e.id).length > 0 || regionUsers(sketch, e.id).length > 0}
            title={
              usersOf(e.id).length
                ? `${usersOf(e.id).map((o) => o.name).join(', ')}이(가) 쓰고 있어 지울 수 없습니다`
                : regionUsers(sketch, e.id).length
                  ? `영역 ${regionUsers(sketch, e.id).join(', ')}이(가) 쓰고 있어 지울 수 없습니다`
                  : undefined
            }
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
        <button onClick={() => submitNow({ type: 'add_ellipse', sketch: sketch.id, id: nextEntity('ellipse'), width: 20, height: 10 })} data-testid="add-ellipse">
          + 타원
        </button>
        <button
          title="삼각형으로 시작하는 다각형 (꼭짓점을 옮기고 구속을 더해 모양을 정합니다). 뷰포트 다각형 도구(P)로도 그릴 수 있습니다"
          onClick={() =>
            submitNow({ type: 'add_polygon', sketch: sketch.id, id: nextEntity('poly'), points: [[-10, -8], [10, -8], [0, 10]] })
          }
        >
          + 다각형
        </button>
        {sketch.entities.some((e) => CLOSED.has(e.type)) && (
          <button
            title="닫힌 요소들로 영역 단면을 만듭니다: 첫 요소에서 나머지를 뺍니다 (구멍 뚫린 판 등). 영역에서 합치기·빼기를 바꿀 수 있습니다"
            data-testid="add-region"
            onClick={() => {
              const closed = sketch.entities.filter((e) => CLOSED.has(e.type));
              submitNow({ type: 'add_region', sketch: sketch.id, id: nextEntity('region'), items: closed.map((e, k) => ({ entity: e.id, op: k === 0 ? 'add' : 'subtract' })) });
            }}
          >
            + 영역 (합치기·빼기)
          </button>
        )}
      </div>
      <ConstraintPanel sketch={sketch} />
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
        title={users.length ? '이 스케치를 쓰는 돌출·회전 객체를 먼저 삭제하세요' : undefined}
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
      <RevolveAction sketch={sketch} entityId={entityId} />
    </>
  );
}

/** 스케치 v 축(u = 0) 둘레로 회전 — 컵·손잡이·노브처럼 축대칭인 물체. 프로파일은 u ≥ 0 쪽에 있어야 한다 */
function RevolveAction({ sketch, entityId }: { sketch: Sketch; entityId: string }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const [angle, setAngle] = useState(360);
  const prof = resolveProfile(sketch, entityId);
  const axisErr = prof ? revolveProfileError(prof) : null;
  return (
    <>
      <NumberField label="회전 각도" unit="°" value={angle} onCommit={setAngle} testId={`revolve-angle-${entityId}`} />
      <button
        data-testid={`revolve-${entityId}`}
        disabled={!prof || !!axisErr}
        title={axisErr ?? '스케치 v 축(u = 0) 둘레로 회전'}
        onClick={() => submitNow({ type: 'revolve', sketch: sketch.id, profile: entityId, angle })}
      >
        회전 (v 축 둘레)
      </button>
    </>
  );
}

/** 돌출 객체: 원본 스케치 윤곽 치수(직접 수정) + 관통 구멍 */
export function ExtrudeFields({ object, model }: { object: Extract<CadObject, { kind: 'extrude' | 'revolve' }>; model: ModelDefinition }) {
  const select = useSceneStore((s) => s.select);
  const submitNow = useSceneStore((s) => s.submitNow);
  const ref = object.kind === 'extrude' ? object.extrude : object.revolve;
  const sketch = findSketch(model, ref.sketch);
  const entity = sketch?.entities.find((e) => e.id === ref.profile);
  if (!sketch || !entity) return <p className="muted small">원본 스케치를 찾을 수 없습니다: {ref.sketch}</p>;
  return (
    <>
      {object.kind === 'extrude' && object.extrude.thin !== undefined && (
        <fieldset>
          <legend>리브 (얇은 돌출)</legend>
          <NumberField label="두께" unit="mm" value={object.extrude.thin} onCommit={(v) => submitNow({ type: 'set_thin', target: object.id, thin: v })} testId="rib-thin" />
        </fieldset>
      )}
      <fieldset>
        <legend>윤곽 ({sketch.name})</legend>
        <EntityDimensions sketch={sketch} entity={entity} />
        <button onClick={() => select(sketch.id)} title="원본 스케치를 선택합니다">
          스케치 열기
        </button>
      </fieldset>
      {object.kind === 'extrude' && object.extrude.thin === undefined && <HoleAction object={object} model={model} />}
    </>
  );
}

function HoleAction({ object, model }: { object: Extract<CadObject, { kind: 'extrude' }>; model: ModelDefinition }) {
  const dispatchBatch = useSceneStore((s) => s.dispatchBatch);
  const sketch = findSketch(model, object.extrude.sketch);
  const profile = sketch ? profileOf(sketch, object.extrude) : null;
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

/** 각도 평면: 기준 평면, 회전축(그 평면의 u·v), 각도 */
function AngledPlaneFields({ sketch, plane }: { sketch: Sketch; plane: AngledPlane }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const set = (patch: Partial<AngledPlane>) => submitNow({ type: 'set_sketch_plane', sketch: sketch.id, plane: { ...plane, ...patch } });
  const [u, v] = planeAxes({ type: plane.base, offset: 0 });
  return (
    <>
      <div className="field">
        <label htmlFor="angled-base">기준</label>
        <select id="angled-base" value={plane.base} onChange={(e) => set({ base: e.target.value as StandardPlane['type'] })}>
          {(Object.keys(PLANE_LABEL) as StandardPlane['type'][]).map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>
      </div>
      <div className="field">
        <label htmlFor="angled-axis">회전축</label>
        <select id="angled-axis" value={plane.axis} onChange={(e) => set({ axis: e.target.value as 'u' | 'v' })}>
          <option value="u">{u} 축 (기준 평면의 가로)</option>
          <option value="v">{v} 축 (기준 평면의 세로)</option>
        </select>
      </div>
      <NumberField label="각도" unit="°" value={plane.angle} onCommit={(a) => set({ angle: a })} testId="angled-angle" />
    </>
  );
}
