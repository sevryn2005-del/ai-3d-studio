/**
 * 조립품 탭 패널 (형식 v11): 메이트(추가·목록·삭제·자유도), 간섭 검사, 부품표(BOM).
 * 모델 변경은 모두 명령(add_mate·set_mate·delete_mate)으로 — 실행기가 부품 위치를 다시 푼다.
 */
import { useMemo, useState } from 'react';
import type { Mate, MateRef } from '../../cad/commandTypes';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { MATE_LABEL, isAxisRef, mateDof, mateRefsOf, refObject } from '../../cad/mates';
import { startMatePick } from './PickFlows';
import { topLevelObjects } from '../../cad/modelGraph';
import { bomCsv, bomRows } from '../../features/assembly/bom';
import { formatMm } from '../../cad/units';
import { useEditorStore } from '../../features/selection/editorStore';
import { getActiveEngine, useActiveEngineId } from '../../features/engine/engines';
import type { InterferencePair } from '../../features/engine/types';
import { downloadBlob } from '../../features/projects/projectStorage';
import { useProjectStore } from '../../features/projects/projectStore';
import { autoExplode, explodeOffset } from '../../cad/explode';
import { NumberField } from '../PropertyPanel/NumberField';

const TYPES = Object.keys(MATE_LABEL) as Mate['type'][];

export function AssemblyPanels() {
  const panel = useEditorStore((s) => s.assemblyPanel);
  if (panel === 'mate') return <MatePanel />;
  if (panel === 'interference') return <InterferencePanel />;
  if (panel === 'bom') return <BomPanel />;
  if (panel === 'explode') return <ExplodePanel />;
  return null;
}

const close = () => useEditorStore.getState().setAssemblyPanel(null);

function MatePanel() {
  const model = useSceneStore(selectModel);
  const submitNow = useSceneStore((s) => s.submitNow);
  const [type, setType] = useState<Mate['type']>('coincident');
  const [a, setA] = useState('');
  const [b, setB] = useState('');
  const [value, setValue] = useState('0');
  const [flip, setFlip] = useState(false);
  /** 화면에서 고른 이름 없는 면·축 (목록에 더해 고를 수 있게) */
  const [extra, setExtra] = useState<MateRef[]>([]);
  const tops = topLevelObjects(model);
  const name = (ref: MateRef) => {
    if (typeof ref !== 'string') return `${model.objects.find((x) => x.id === ref.object)?.name ?? ref.object} · 고른 ${ref.kind === 'axis' ? '축' : '면'}`;
    const [id, part] = ref.split('.');
    const o = model.objects.find((x) => x.id === id);
    return `${o?.name ?? id}${part ? ` · ${part === 'axis' ? '축' : part}` : ''}`;
  };
  // 메이트 종류에 맞는 참조만: 일치·거리 = 면, 동심 = 축, 고정 = 객체, 나머지 = 면·축
  const fits = (r: MateRef) => (type === 'concentric' ? isAxisRef(r) : type === 'coincident' || type === 'distance' ? !isAxisRef(r) : true);
  const all: MateRef[] =
    type === 'fix' ? tops.map((o) => o.id) : [...tops.flatMap((o) => mateRefsOf(model, o)), ...extra].filter(fits);
  const keyOf = (r: MateRef) => (typeof r === 'string' ? r : JSON.stringify(r));
  const byKey = new Map(all.map((r) => [keyOf(r), r]));
  const refs = [...byKey.keys()];
  const objOf = (k: string) => refObject(byKey.get(k)!);
  const ra = refs.includes(a) ? a : (refs[0] ?? '');
  const rb = refs.includes(b) && objOf(b) !== objOf(ra) ? b : (refs.find((r) => objOf(r) !== objOf(ra)) ?? '');
  const pick = (set: (k: string) => void) =>
    startMatePick((ref) => {
      if (typeof ref !== 'string') setExtra((x) => [...x, ref]);
      set(keyOf(ref));
    });
  const dof = useMemo(() => mateDof(model), [model]);
  const dragWithMates = useEditorStore((s) => s.dragWithMates);
  const setDragWithMates = useEditorStore((s) => s.setDragWithMates);
  const needsValue = type === 'distance' || type === 'angle';
  const add = () => {
    const v = Number(value);
    submitNow({
      type: 'add_mate',
      mate: type,
      refs: type === 'fix' ? [byKey.get(ra)!] : [byKey.get(ra)!, byKey.get(rb)!],
      ...(needsValue && Number.isFinite(v) ? { value: v } : {}),
      ...((type === 'coincident' || type === 'distance') && flip ? { flip: true } : {}),
    });
  };
  return (
    <div className="view-panel mass-panel" role="dialog" aria-label="메이트" data-testid="mate-panel">
      <div className="pm-head">
        <strong>메이트</strong> <span className="muted small" data-testid="mate-dof">자유도 {dof}{(model.mates?.length ?? 0) > 0 && dof === 0 ? ' · 완전 정의' : ''}</span>
      </div>
      <label className="check" title="켜면 메이트된 부품을 이동 기즈모로 끌 때 메이트가 허락하는 방향(남은 자유도)으로만 움직입니다. 끄면 옮긴 부품은 그 자리, 짝 부품이 따라옵니다">
        <input type="checkbox" checked={dragWithMates} onChange={(e) => setDragWithMates(e.target.checked)} data-testid="mate-drag" /> 메이트 지키며 끌기
      </label>
      <label className="field">
        종류
        <select value={type} onChange={(e) => setType(e.target.value as Mate['type'])} data-testid="mate-type">
          {TYPES.map((t) => <option key={t} value={t}>{MATE_LABEL[t]}</option>)}
        </select>
      </label>
      <label className="field">
        {type === 'fix' ? '부품' : '기준 (고정 쪽)'}
        <select value={ra} onChange={(e) => setA(e.target.value)} data-testid="mate-a">
          {refs.map((r) => <option key={r} value={r}>{name(byKey.get(r)!)}</option>)}
        </select>
        {type !== 'fix' && (
          <button onClick={() => pick(setA)} data-testid="mate-pick-a" title="화면에서 면을 클릭해 고릅니다">
            화면에서
          </button>
        )}
      </label>
      {type !== 'fix' && (
        <label className="field">
          움직일 부품
          <select value={rb} onChange={(e) => setB(e.target.value)} data-testid="mate-b">
            {refs.filter((r) => objOf(r) !== objOf(ra)).map((r) => <option key={r} value={r}>{name(byKey.get(r)!)}</option>)}
          </select>
          <button onClick={() => pick(setB)} data-testid="mate-pick-b" title="화면에서 면을 클릭해 고릅니다">
            화면에서
          </button>
        </label>
      )}
      {needsValue && (
        <label className="field">
          {type === 'angle' ? '각도 (°)' : '거리 (mm)'}
          <input value={value} onChange={(e) => setValue(e.target.value)} inputMode="decimal" data-testid="mate-value" />
        </label>
      )}
      {(type === 'coincident' || type === 'distance') && (
        <label className="check">
          <input type="checkbox" checked={flip} onChange={(e) => setFlip(e.target.checked)} data-testid="mate-flip" /> 같은 방향 (기본: 마주 보게)
        </label>
      )}
      <div className="row">
        <button className="ok" disabled={!ra || (type !== 'fix' && !rb)} onClick={add} data-testid="mate-ok">
          ✓ 메이트 추가
        </button>
        <button className="cancel" onClick={close}>
          ✕ 닫기
        </button>
      </div>
      <ul className="constraint-list" aria-label="메이트 목록">
        {(model.mates ?? []).map((m) => (
          <li key={m.id} data-testid={`mate-${m.id}`}>
            <span>
              {MATE_LABEL[m.type]} {m.refs.map(name).join(' ↔ ')}
              {m.value !== undefined ? ` ${formatMm(m.value)}${m.type === 'angle' ? '°' : 'mm'}` : ''}
            </span>
            <button onClick={() => submitNow({ type: 'delete_mate', mate: m.id })} title="메이트 삭제" data-testid={`delete-mate-${m.id}`}>
              삭제
            </button>
          </li>
        ))}
      </ul>
      {!model.mates?.length && <p className="muted small">처음 만든 부품이 고정되고, 둘째로 고른 부품이 움직입니다.</p>}
    </div>
  );
}

function InterferencePanel() {
  const model = useSceneStore(selectModel);
  const engineId = useActiveEngineId();
  const [state, setState] = useState<{ busy: boolean; pairs?: InterferencePair[]; error?: string }>({ busy: false });
  const name = (id: string) => model.objects.find((o) => o.id === id)?.name ?? id;
  const run = async () => {
    const engine = engineId ? getActiveEngine(engineId) : null;
    if (!engine) return setState({ busy: false, error: 'CAD 엔진을 사용할 수 없습니다' });
    setState({ busy: true });
    try {
      setState({ busy: false, pairs: await engine.interference(model) });
    } catch (e) {
      setState({ busy: false, error: (e as Error).message });
    }
  };
  return (
    <div className="view-panel mass-panel" role="dialog" aria-label="간섭 검사" data-testid="interference-panel">
      <div className="pm-head">
        <strong>간섭 검사</strong>
      </div>
      <p className="muted small">부품(최상위 객체)끼리 서로 파고든 부피를 계산합니다. 맞닿기만 한 것은 간섭이 아닙니다.</p>
      <button onClick={() => void run()} disabled={state.busy} data-testid="interference-run">
        {state.busy ? '계산 중…' : '검사'}
      </button>
      {state.error && <p className="error small">{state.error}</p>}
      {state.pairs && (
        <ul className="constraint-list" data-testid="interference-result">
          {state.pairs.length === 0 && <li>간섭 없음 ✓</li>}
          {state.pairs.map((p) => (
            <li key={`${p.a}:${p.b}`}>
              {name(p.a)} ↔ {name(p.b)} <span className="muted">{formatMm(p.volume)} mm³</span>
            </li>
          ))}
        </ul>
      )}
      <div className="row">
        <button className="cancel" onClick={close}>
          ✕ 닫기
        </button>
      </div>
    </div>
  );
}

function BomPanel() {
  const model = useSceneStore(selectModel);
  const rows = useMemo(() => bomRows(model), [model]);
  const save = () => void downloadBlob(new Blob([bomCsv(rows)], { type: 'text/csv' }), `${useProjectStore.getState().name} 부품표.csv`);
  return (
    <div className="view-panel mass-panel bom-panel" role="dialog" aria-label="부품표" data-testid="bom-panel">
      <div className="pm-head">
        <strong>부품표 (BOM)</strong>
      </div>
      <table className="usage">
        <thead>
          <tr>
            <th>번호</th>
            <th>이름</th>
            <th>크기</th>
            <th>수량</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.no} data-testid={`bom-row-${r.no}`}>
              <td>{r.no}</td>
              <td>
                {r.name} <span className="muted small">{r.kind}</span>
              </td>
              <td>{r.size}</td>
              <td>{r.qty}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="row">
        <button onClick={save} disabled={!rows.length} data-testid="bom-csv">
          CSV 저장
        </button>
        <button className="cancel" onClick={close}>
          ✕ 닫기
        </button>
      </div>
    </div>
  );
}

/** 분해도 (형식 v41): 분해 보기 켜기·자동 분해·고른 부품의 이동량·지우기 — 설계 위치는 그대로, 화면만 */
function ExplodePanel() {
  const model = useSceneStore(selectModel);
  const selectedId = useSceneStore((s) => s.selectedId);
  const on = useEditorStore((s) => s.exploded);
  const [factor, setFactor] = useState(1);
  const roots = topLevelObjects(model);
  const sel = roots.find((o) => o.id === selectedId);
  const submit = useSceneStore.getState().submitNow;
  const list = model.explode ?? [];
  const setPart = (id: string, k: number, v: number) => {
    const cur = explodeOffset(model, id);
    const next = [...cur] as [number, number, number];
    next[k] = v;
    submit({ type: 'set_explode', offsets: [...list.filter((e) => e.id !== id), { id, offset: next }] });
  };
  return (
    <div className="view-panel mass-panel" role="dialog" aria-label="분해도" data-testid="explode-panel">
      <div className="pm-head">
        <strong>분해도</strong>
        <button onClick={close} title="닫기">
          ✕
        </button>
      </div>
      <label className="check">
        <input type="checkbox" checked={on} onChange={(e) => useEditorStore.getState().setExploded(e.target.checked)} data-testid="explode-on" />
        분해 보기 (화면만 — 위치·메이트·내보내기는 그대로)
      </label>
      <div className="field">
        <label htmlFor="explode-factor">벌릴 배율</label>
        <input id="explode-factor" type="number" min={0.1} max={10} step={0.1} value={factor} onChange={(e) => setFactor(Math.max(0.1, Math.min(10, Number(e.target.value) || 1)))} />
      </div>
      <button
        onClick={() => {
          const offsets = autoExplode(model, factor);
          if (!offsets.length) return useSceneStore.getState().reportError('분해도: 부품이 둘 이상 있어야 자동으로 벌릴 수 있습니다');
          if (submit({ type: 'set_explode', offsets }).status === 'applied') useEditorStore.getState().setExploded(true);
        }}
        data-testid="explode-auto"
        title="조립품 가운데에서 각 부품 원점 쪽으로 벌립니다 (가운데에 겹친 부품은 위로)"
      >
        자동 분해
      </button>
      {sel ? (
        <>
          <p className="muted small">고른 부품: {sel.name}</p>
          {(['X', 'Y', 'Z'] as const).map((a, k) => (
            <NumberField key={a} label={`이동 ${a}`} unit="mm" value={explodeOffset(model, sel.id)[k]!} onCommit={(v) => setPart(sel.id, k, v)} testId={`explode-${a.toLowerCase()}`} />
          ))}
        </>
      ) : (
        <p className="muted small">부품을 고르면 그 부품의 분해 이동량을 바꿀 수 있습니다.</p>
      )}
      <button disabled={!list.length} onClick={() => submit({ type: 'set_explode', offsets: [] })} data-testid="explode-clear">
        분해 지우기
      </button>
    </div>
  );
}
