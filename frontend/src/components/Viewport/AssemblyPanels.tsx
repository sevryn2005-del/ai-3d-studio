/**
 * 조립품 탭 패널 (형식 v11): 메이트(추가·목록·삭제·자유도), 간섭 검사, 부품표(BOM).
 * 모델 변경은 모두 명령(add_mate·set_mate·delete_mate)으로 — 실행기가 부품 위치를 다시 푼다.
 */
import { useMemo, useState } from 'react';
import type { Mate } from '../../cad/commandTypes';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { MATE_LABEL, mateDof, mateRefsOf } from '../../cad/mates';
import { topLevelObjects } from '../../cad/modelGraph';
import { bomCsv, bomRows } from '../../features/assembly/bom';
import { formatMm } from '../../cad/units';
import { useEditorStore } from '../../features/selection/editorStore';
import { getActiveEngine, useActiveEngineId } from '../../features/engine/engines';
import type { InterferencePair } from '../../features/engine/types';
import { downloadBlob } from '../../features/projects/projectStorage';
import { useProjectStore } from '../../features/projects/projectStore';

const TYPES = Object.keys(MATE_LABEL) as Mate['type'][];

export function AssemblyPanels() {
  const panel = useEditorStore((s) => s.assemblyPanel);
  if (panel === 'mate') return <MatePanel />;
  if (panel === 'interference') return <InterferencePanel />;
  if (panel === 'bom') return <BomPanel />;
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
  const tops = topLevelObjects(model);
  const name = (ref: string) => {
    const [id, part] = ref.split('.');
    const o = model.objects.find((x) => x.id === id);
    return `${o?.name ?? id}${part ? ` · ${part === 'axis' ? '축' : part}` : ''}`;
  };
  // 메이트 종류에 맞는 참조만: 일치·거리 = 면, 동심 = 축, 고정 = 객체, 나머지 = 면·축
  const refs = tops.flatMap((o) =>
    type === 'fix' ? [o.id] : mateRefsOf(model, o).filter((r) => (type === 'concentric' ? r.endsWith('.axis') : type === 'coincident' || type === 'distance' ? !r.endsWith('.axis') : true)),
  );
  const ra = refs.includes(a) ? a : (refs[0] ?? '');
  const rb = refs.includes(b) && b.split('.')[0] !== ra.split('.')[0] ? b : (refs.find((r) => r.split('.')[0] !== ra.split('.')[0]) ?? '');
  const dof = useMemo(() => mateDof(model), [model]);
  const needsValue = type === 'distance' || type === 'angle';
  const add = () => {
    const v = Number(value);
    submitNow({
      type: 'add_mate',
      mate: type,
      refs: type === 'fix' ? [ra] : [ra, rb],
      ...(needsValue && Number.isFinite(v) ? { value: v } : {}),
      ...((type === 'coincident' || type === 'distance') && flip ? { flip: true } : {}),
    });
  };
  return (
    <div className="view-panel mass-panel" role="dialog" aria-label="메이트" data-testid="mate-panel">
      <div className="pm-head">
        <strong>메이트</strong> <span className="muted small" data-testid="mate-dof">자유도 {dof}{(model.mates?.length ?? 0) > 0 && dof === 0 ? ' · 완전 정의' : ''}</span>
      </div>
      <label className="field">
        종류
        <select value={type} onChange={(e) => setType(e.target.value as Mate['type'])} data-testid="mate-type">
          {TYPES.map((t) => <option key={t} value={t}>{MATE_LABEL[t]}</option>)}
        </select>
      </label>
      <label className="field">
        {type === 'fix' ? '부품' : '기준 (고정 쪽)'}
        <select value={ra} onChange={(e) => setA(e.target.value)} data-testid="mate-a">
          {refs.map((r) => <option key={r} value={r}>{name(r)}</option>)}
        </select>
      </label>
      {type !== 'fix' && (
        <label className="field">
          움직일 부품
          <select value={rb} onChange={(e) => setB(e.target.value)} data-testid="mate-b">
            {refs.filter((r) => r.split('.')[0] !== ra.split('.')[0]).map((r) => <option key={r} value={r}>{name(r)}</option>)}
          </select>
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
