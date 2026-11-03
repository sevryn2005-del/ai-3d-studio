import { useEffect, useMemo, useState } from 'react';
import type { BooleanOperation, CadObject, ModelDefinition, ObjectId, Vec3 } from '../../cad/commandTypes';
import { selectModel, selectSelectedObject, useSceneStore } from '../../cad/sceneStore';
import { KIND_INFO, OPERATION_INFO, kindLabel, sizeSummary } from '../../cad/objectKinds';
import { byId, childIds, parentMap, topLevelObjects } from '../../cad/modelGraph';
import { NumberField } from './NumberField';

export function PropertyPanel() {
  const model = useSceneStore(selectModel);
  const selected = useSceneStore(selectSelectedObject);
  const index = useMemo(() => byId(model), [model]);
  const roots = useMemo(() => topLevelObjects(model), [model]);

  return (
    <aside className="panel properties" aria-label="속성 패널">
      <header className="panel-header">객체</header>
      <ul className="object-list" aria-label="객체 목록">
        {roots.length === 0 && <li className="empty">객체가 없습니다</li>}
        {roots.map((o) => (
          <ObjectTreeItem key={o.id} object={o} index={index} depth={0} />
        ))}
      </ul>

      <header className="panel-header">속성</header>
      {selected ? (
        <ObjectProperties key={selected.id} object={selected} model={model} />
      ) : (
        <p className="empty">뷰포트나 목록에서 객체를 선택하세요.</p>
      )}
    </aside>
  );
}

function ObjectTreeItem({ object, index, depth }: { object: CadObject; index: Map<ObjectId, CadObject>; depth: number }) {
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
          <span className="muted">{sizeSummary(object)}</span>
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
  const dispatch = useSceneStore((s) => s.dispatch);
  const { transform } = object;
  const [name, setName] = useState(object.name);
  useEffect(() => setName(object.name), [object.name]);

  const parentId = parentMap(model).get(object.id);
  const parent = parentId ? model.objects.find((o) => o.id === parentId) : undefined;

  const setVec = (field: 'position' | 'rotation', axis: 0 | 1 | 2) => (v: number) => {
    const next = [...transform[field]] as Vec3;
    next[axis] = v;
    dispatch({ type: 'set_transform', target: object.id, [field]: next });
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
              ? dispatch({ type: 'rename_object', target: object.id, name })
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
              unit="mm"
              value={(object.params as Record<string, number>)[f.key]!}
              onCommit={(v) => dispatch({ type: 'set_params', target: object.id, params: { [f.key]: v } })}
              testId={`param-${f.key}`}
            />
          ))}
        </fieldset>
      )}

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

      {!parent && <BooleanActions object={object} model={model} />}

      <div className="row">
        <button
          disabled={!!parent}
          title={parent ? '불리언에 포함된 객체는 상위 객체를 복제하세요' : undefined}
          onClick={() => dispatch({ type: 'duplicate_object', target: object.id })}
        >
          복제
        </button>
        <button
          className="danger"
          disabled={!!parent}
          title={parent ? '불리언에 포함된 객체는 단독으로 삭제할 수 없습니다' : undefined}
          onClick={() => dispatch({ type: 'delete_object', target: object.id })}
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
  const dispatch = useSceneStore((s) => s.dispatch);
  const others = topLevelObjects(model).filter((o) => o.id !== object.id);
  const [toolId, setToolId] = useState<ObjectId>(others[0]?.id ?? '');
  useEffect(() => {
    if (!others.some((o) => o.id === toolId)) setToolId(others[0]?.id ?? '');
  }, [others, toolId]);

  if (others.length === 0) return null;
  const run = (op: BooleanOperation) => dispatch({ type: op, base: object.id, tools: [toolId] });

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
