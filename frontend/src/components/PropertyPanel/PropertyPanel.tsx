import { useEffect, useMemo, useState } from 'react';
import type { BooleanOperation, CadObject, ModelDefinition, ObjectId, Vec3 } from '../../cad/commandTypes';
import { selectModel, selectSelectedObject, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { KIND_INFO, OPERATION_INFO, kindLabel, sizeSummary } from '../../cad/objectKinds';
import { byId, childIds, parentMap, topLevelObjects } from '../../cad/modelGraph';
import { NumberField } from './NumberField';
import { dropToBedCommand } from '../../cad/printCheck';
import { maxEdgeSize } from '../../cad/edgeFeature';
import { formatMm } from '../../cad/units';
import { usePrintCheck } from '../../features/print/usePrintCheck';
import { ExtrudeFields, FaceSketchAction, SketchProperties } from './SketchFields';
import { PropertyManager } from './PropertyManager';
import { useEditorStore } from '../../features/selection/editorStore';

/** 원점 기준 평면 (Z-up: 윗면 = XY, 정면 = XZ, 우측면 = YZ) */
const ORIGIN_PLANES = [
  { type: 'XZ', label: '정면' },
  { type: 'XY', label: '윗면' },
  { type: 'YZ', label: '우측면' },
] as const;

export function PropertyPanel() {
  const model = useSceneStore(selectModel);
  const selected = useSceneStore(selectSelectedObject);
  const selectedSketch = useSceneStore(selectSelectedSketch);
  const selectedId = useSceneStore((s) => s.selectedId);
  const select = useSceneStore((s) => s.select);
  const index = useMemo(() => byId(model), [model]);
  const roots = useMemo(() => topLevelObjects(model), [model]);

  const pending = useEditorStore((s) => s.pending);
  const selectedPlane = useEditorStore((s) => s.selectedPlane);
  const pickPlane = (t: (typeof ORIGIN_PLANES)[number]['type']) => {
    useEditorStore.getState().selectPlane(selectedPlane === t ? null : t);
    select(null);
  };

  return (
    <aside className="panel properties" aria-label="속성 패널">
      <header className="panel-header">피처 트리</header>
      <ul className="origin-list" aria-label="기준 평면">
        {ORIGIN_PLANES.map((p) => (
          <li key={p.type}>
            <button
              className={selectedPlane === p.type ? 'active' : ''}
              data-plane={p.type}
              onClick={() => pickPlane(p.type)}
              title={`${p.label} 평면 — 선택한 뒤 위 "스케치" 를 누르면 이 평면에 스케치를 시작합니다`}
            >
              <span>
                <span className="tree-icon plane" aria-hidden="true" /> {p.label}
              </span>
              <span className="muted">{p.type}</span>
            </button>
          </li>
        ))}
      </ul>
      <header className="panel-header sub">객체</header>
      <ul className="object-list" aria-label="객체 목록">
        {roots.length === 0 && <li className="empty">객체가 없습니다</li>}
        {roots.map((o) => (
          <ObjectTreeItem key={o.id} object={o} index={index} depth={0} />
        ))}
      </ul>

      {model.sketches.length > 0 && (
        <>
          <header className="panel-header sub">스케치</header>
          <ul className="object-list" aria-label="스케치 목록">
            {model.sketches.map((sk) => (
              <li key={sk.id}>
                <button className={sk.id === selectedId ? 'active' : ''} onClick={() => select(sk.id)} data-sketch-id={sk.id}>
                  <span>{sk.name}</span>
                  <span className="muted">{sk.entities.length}개 요소</span>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}

      <header className="panel-header">{pending ? '속성 관리자' : '속성'}</header>
      {pending ? (
        <PropertyManager key={`${pending.kind}-${pending.sketch}`} model={model} />
      ) : selected ? (
        <ObjectProperties key={selected.id} object={selected} model={model} />
      ) : selectedSketch ? (
        <SketchProperties key={selectedSketch.id} sketch={selectedSketch} model={model} />
      ) : (
        <p className="empty">뷰포트나 목록에서 객체를 선택하세요.</p>
      )}
    </aside>
  );
}

function ObjectTreeItem({ object, index, depth }: { object: CadObject; index: Map<ObjectId, CadObject>; depth: number }) {
  const model = useSceneStore(selectModel);
  const selectedId = useSceneStore((s) => s.selectedId);
  const select = useSceneStore((s) => s.select);
  const children = childIds(object);
  return (
    <>
      <li>
        <button
          className={object.id === selectedId ? 'active' : ''}
          style={{ paddingLeft: 10 + depth * 14 }}
          onClick={() => select(object.id)}
          data-object-id={object.id}
        >
          <span>
            {depth > 0 && <span className="muted">↳ </span>}
            {object.name}
          </span>
          <span className="muted">{sizeSummary(object, model)}</span>
        </button>
      </li>
      {children.map((id) => {
        const child = index.get(id);
        return child ? <ObjectTreeItem key={id} object={child} index={index} depth={depth + 1} /> : null;
      })}
    </>
  );
}

function ObjectProperties({ object, model }: { object: CadObject; model: ModelDefinition }) {
  const submit = useSceneStore((s) => s.submitNow);
  const { transform } = object;
  const [name, setName] = useState(object.name);
  useEffect(() => setName(object.name), [object.name]);

  const parentId = parentMap(model).get(object.id);
  const parent = parentId ? model.objects.find((o) => o.id === parentId) : undefined;

  const setVec = (field: 'position' | 'rotation', axis: 0 | 1 | 2) => (v: number) => {
    const next = [...transform[field]] as Vec3;
    next[axis] = v;
    submit(field === 'position' ? { type: 'set_transform', target: object.id, position: next } : { type: 'set_transform', target: object.id, rotation: next });
  };

  return (
    <div className="props">
      <div className="field">
        <label htmlFor="obj-name">이름</label>
        <input
          id="obj-name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onBlur={() =>
            name.trim() && name !== object.name
              ? submit({ type: 'rename_object', target: object.id, name })
              : setName(object.name)
          }
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
        />
      </div>
      <div className="muted small">
        ID: {object.id} · 유형: {kindLabel(object)}
        {parent && <> · 상위: {parent.name}</>}
      </div>

      {object.kind === 'boolean' ? (
        <BooleanInfo object={object} model={model} />
      ) : (
        <fieldset>
          <legend>치수</legend>
          {KIND_INFO[object.kind].params.map((f) => (
            <NumberField
              key={f.key}
              label={f.label}
              unit={f.unit ?? 'mm'}
              value={(object.params as Record<string, number>)[f.key]!}
              onCommit={(v) => submit({ type: 'set_params', target: object.id, params: { [f.key]: v } })}
              testId={`param-${f.key}`}
            />
          ))}
        </fieldset>
      )}

      {object.kind === 'box' && <EdgeFeatureFields object={object} />}
      {(object.kind === 'extrude' || object.kind === 'revolve') && <ExtrudeFields object={object} model={model} />}
      <FaceSketchAction key={`face-${object.id}`} object={object} model={model} />

      <fieldset>
        <legend>{parent ? `위치 (${parent.name} 기준)` : '위치 (바닥면 중심)'}</legend>
        {(['X', 'Y', 'Z'] as const).map((a, i) => (
          <NumberField key={a} label={a} unit="mm" value={transform.position[i]!} onCommit={setVec('position', i as 0 | 1 | 2)} />
        ))}
      </fieldset>

      <fieldset>
        <legend>{parent ? `회전 (${parent.name} 기준)` : '회전'}</legend>
        {(['X', 'Y', 'Z'] as const).map((a, i) => (
          <NumberField key={a} label={a} unit="°" value={transform.rotation[i]!} onCommit={setVec('rotation', i as 0 | 1 | 2)} />
        ))}
      </fieldset>

      {!parent && <DropToBed object={object} />}

      {!parent && <BooleanActions object={object} model={model} />}

      <div className="row">
        <button
          disabled={!!parent}
          title={parent ? '불리언에 포함된 객체는 상위 객체를 복제하세요' : undefined}
          onClick={() => submit({ type: 'duplicate_object', target: object.id })}
        >
          복제
        </button>
        <button
          className="danger"
          disabled={!!parent}
          title={parent ? '불리언에 포함된 객체는 단독으로 삭제할 수 없습니다' : undefined}
          onClick={() => submit({ type: 'delete_object', target: object.id })}
        >
          삭제
        </button>
      </div>
    </div>
  );
}

function BooleanInfo({ object, model }: { object: Extract<CadObject, { kind: 'boolean' }>; model: ModelDefinition }) {
  const select = useSceneStore((s) => s.select);
  const name = (id: ObjectId) => model.objects.find((o) => o.id === id)?.name ?? id;
  const op = OPERATION_INFO[object.boolean.operation];
  return (
    <fieldset>
      <legend>{op.label}</legend>
      <div className="operands">
        <button onClick={() => select(object.boolean.base)}>{name(object.boolean.base)}</button>
        {object.boolean.tools.map((t) => (
          <span key={t}>
            <span className="muted"> {op.symbol} </span>
            <button onClick={() => select(t)}>{name(t)}</button>
          </span>
        ))}
      </div>
      <p className="muted small">포함된 객체를 선택하면 치수와 위치를 바꿀 수 있습니다.</p>
    </fieldset>
  );
}

/** 선택한(최상위) 객체를 기준으로 다른 최상위 객체와 불리언 연산 */
function BooleanActions({ object, model }: { object: CadObject; model: ModelDefinition }) {
  const submit = useSceneStore((s) => s.submitNow);
  const others = topLevelObjects(model).filter((o) => o.id !== object.id);
  const [toolId, setToolId] = useState<ObjectId>(others[0]?.id ?? '');
  useEffect(() => {
    if (!others.some((o) => o.id === toolId)) setToolId(others[0]?.id ?? '');
  }, [others, toolId]);

  if (others.length === 0) return null;
  const run = (op: BooleanOperation) => submit({ type: op, base: object.id, tools: [toolId] });

  return (
    <fieldset>
      <legend>다른 객체와 연산</legend>
      <select aria-label="연산 대상" value={toolId} onChange={(e) => setToolId(e.target.value)}>
        {others.map((o) => (
          <option key={o.id} value={o.id}>
            {o.name}
          </option>
        ))}
      </select>
      <div className="row">
        {(['cut', 'union', 'intersect'] as const).map((op) => (
          <button key={op} onClick={() => run(op)} title={`${object.name} ${OPERATION_INFO[op].symbol} 선택한 객체`}>
            {OPERATION_INFO[op].verb}
          </button>
        ))}
      </div>
    </fieldset>
  );
}

/** 선택한 최상위 객체의 가장 낮은 점을 바닥(z=0)에 맞춘다 (회전·불리언 결과 기준) */
function DropToBed({ object }: { object: CadObject }) {
  const { boxes } = usePrintCheck();
  const submit = useSceneStore((s) => s.submitNow);
  const box = boxes.get(object.id);
  const cmd = box ? dropToBedCommand(object, box) : null;
  return (
    <button
      className="drop-to-bed"
      disabled={!cmd}
      title={cmd ? '가장 낮은 점을 출력 베드(z=0)에 맞춥니다' : '이미 바닥에 놓여 있습니다'}
      onClick={() => cmd && submit(cmd)}
    >
      바닥에 놓기
    </button>
  );
}

/** 박스 모서리 처리 (필렛·모따기). 바꿀 때마다 fillet/chamfer 명령 1개 → 실행 취소 가능 */
function EdgeFeatureFields({ object }: { object: Extract<CadObject, { kind: 'box' }> }) {
  const submit = useSceneStore((s) => s.submitNow);
  const f = object.edgeFeature;
  const type = f?.type ?? 'none';
  const edges = f?.edges ?? 'all';
  const apply = (t: 'fillet' | 'chamfer', size: number, e: 'all' | 'vertical') =>
    submit(t === 'fillet' ? { type: 'fillet', target: object.id, radius: size, edges: e } : { type: 'chamfer', target: object.id, distance: size, edges: e });
  const max = maxEdgeSize(object.params, edges);
  const defaultSize = Math.min(2, Math.floor(max * 0.5 * 10) / 10 || 0.1);

  return (
    <fieldset>
      <legend>모서리</legend>
      <div className="field">
        <label htmlFor="edge-type">처리</label>
        <select
          id="edge-type"
          value={type}
          onChange={(e) => {
            const v = e.target.value as 'none' | 'fillet' | 'chamfer';
            if (v === 'none') apply(f?.type ?? 'fillet', 0, edges);
            else apply(v, f?.size ?? defaultSize, edges);
          }}
        >
          <option value="none">없음 (각진 모서리)</option>
          <option value="fillet">둥글게 (필렛)</option>
          <option value="chamfer">비스듬히 깎기 (모따기)</option>
        </select>
      </div>
      {f && (
        <>
          <div className="field">
            <label htmlFor="edge-which">범위</label>
            <select id="edge-which" value={edges} onChange={(e) => apply(f.type, f.size, e.target.value as 'all' | 'vertical')}>
              <option value="all">모든 모서리</option>
              <option value="vertical">세로 모서리만</option>
            </select>
          </div>
          <NumberField
            label={f.type === 'fillet' ? '반지름' : '거리'}
            unit="mm"
            value={f.size}
            onCommit={(v) => apply(f.type, v, edges)}
            testId="edge-size"
          />
          <div className="muted small">{formatMm(max)}mm 보다 작게</div>
        </>
      )}
    </fieldset>
  );
}
