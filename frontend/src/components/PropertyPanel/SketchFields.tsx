import { useState } from 'react';
import type { CadObject, DimensionKind, ModelDefinition, Point2, Sketch, SketchEntity } from '../../cad/commandTypes';
import { useSceneStore } from '../../cad/sceneStore';
import { REQUIRED_DIMENSIONS, dimensionValue, findSketch, resolveProfile } from '../../cad/sketch';
import { throughHoleCommands } from '../../cad/sketchActions';
import { formatMm } from '../../cad/units';
import { NumberField } from './NumberField';

const DIM_LABEL: Record<DimensionKind, string> = { width: '폭 (X)', height: '깊이 (Y)', diameter: '지름' };
const ENTITY_LABEL: Record<SketchEntity['type'], string> = { rectangle: '사각형', circle: '원' };

/** 스케치 요소 하나의 치수 입력. 바꾸면 set_dimension 1건 (이 스케치를 쓰는 돌출이 모두 다시 계산됨) */
function EntityDimensions({ sketch, entity }: { sketch: Sketch; entity: SketchEntity }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  return (
    <>
      {REQUIRED_DIMENSIONS[entity.type].map((kind) => (
        <NumberField
          key={kind}
          label={DIM_LABEL[kind]}
          unit="mm"
          value={dimensionValue(sketch, entity.id, kind) ?? 0}
          onCommit={(v) => submitNow({ type: 'set_dimension', sketch: sketch.id, dimension: `${entity.id}.${kind}`, value: v })}
          testId={`dim-${entity.id}.${kind}`}
        />
      ))}
    </>
  );
}

/** 선택한 스케치: 평면, 요소별 치수, 돌출 */
export function SketchProperties({ sketch, model }: { sketch: Sketch; model: ModelDefinition }) {
  const select = useSceneStore((s) => s.select);
  const users = model.objects.filter((o) => o.kind === 'extrude' && o.extrude.sketch === sketch.id);
  return (
    <div className="props" data-testid="sketch-properties">
      <div className="field">
        <span>이름</span>
        <strong>{sketch.name}</strong>
      </div>
      <div className="muted small">
        ID: {sketch.id} · 유형: 스케치 · XY 평면, 높이 {formatMm(sketch.plane.offset)}mm
      </div>
      {sketch.entities.map((e) => (
        <fieldset key={e.id}>
          <legend>
            {ENTITY_LABEL[e.type]} {e.id}
          </legend>
          <EntityDimensions sketch={sketch} entity={e} />
          <div className="muted small">
            중심 ({formatMm(e.center[0])}, {formatMm(e.center[1])}) mm
          </div>
          <ExtrudeAction sketch={sketch} entityId={e.id} />
        </fieldset>
      ))}
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
    </div>
  );
}

function ExtrudeAction({ sketch, entityId }: { sketch: Sketch; entityId: string }) {
  const submitNow = useSceneStore((s) => s.submitNow);
  const [distance, setDistance] = useState(4);
  return (
    <>
      <NumberField label="돌출 거리" unit="mm" value={distance} onCommit={setDistance} testId={`extrude-distance-${entityId}`} />
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
      <NumberField label="중심 X" unit="mm" value={c[0]} onCommit={(v) => setCenter([v, c[1]])} testId="hole-x" />
      <NumberField label="중심 Y" unit="mm" value={c[1]} onCommit={(v) => setCenter([c[0], v])} testId="hole-y" />
      {!plan.ok && <div className="muted small">{plan.error}</div>}
      <button data-testid="hole-apply" disabled={!plan.ok} onClick={() => plan.ok && dispatchBatch(plan.commands)}>
        구멍 뚫기
      </button>
    </fieldset>
  );
}
