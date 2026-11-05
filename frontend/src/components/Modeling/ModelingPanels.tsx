import { useMemo, useState } from 'react';
import type { CadObject, Vec3 } from '../../cad/commandTypes';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { topLevelObjects } from '../../cad/modelGraph';
import { boundaryEdgeCount, centroid, edges, selectedFaces } from '../../cad/polymesh';
import { NumberField } from '../PropertyPanel/NumberField';
import { useModelingStore } from '../../features/modeling/modelingStore';
import { ADD_MESH_ITEMS, addMesh } from '../../features/modeling/modelingOps';
import { MODIFIER_LABEL } from '../../cad/polymeshModifiers';

/** 아웃라이너 (블렌더 오른쪽 위): 객체 목록 · 보이기 토글 · 이름 바꾸기(더블클릭) */
export function Outliner() {
  const model = useSceneStore(selectModel);
  const selectedId = useSceneStore((s) => s.selectedId);
  const roots = useMemo(() => topLevelObjects(model), [model]);
  const [renaming, setRenaming] = useState<string | null>(null);
  const { select, submitNow } = useSceneStore.getState();

  return (
    <section className="outliner" aria-label="아웃라이너" data-testid="outliner">
      <h2>장면</h2>
      {roots.length === 0 && <p className="empty">비어 있음 — Shift+A 로 메시 추가</p>}
      <ul>
        {roots.map((o) => (
          <li key={o.id} aria-selected={o.id === selectedId} className={o.id === selectedId ? 'selected' : ''}>
            <span className="kind" aria-hidden>{o.kind === 'polymesh' ? '▲' : '■'}</span>
            {renaming === o.id ? (
              <input
                autoFocus
                defaultValue={o.name}
                onBlur={(e) => {
                  const v = e.target.value.trim();
                  if (v && v !== o.name) submitNow({ type: 'rename_object', target: o.id, name: v });
                  setRenaming(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
                  if (e.key === 'Escape') setRenaming(null);
                  e.stopPropagation();
                }}
              />
            ) : (
              <button className="name" onClick={() => select(o.id)} onDoubleClick={() => setRenaming(o.id)} title="클릭: 선택 · 더블클릭: 이름 바꾸기">
                {o.name}
              </button>
            )}
            <button
              className="eye"
              aria-pressed={!o.hidden}
              title={o.hidden ? '보이기' : '숨기기'}
              onClick={() => submitNow({ type: 'set_appearance', target: o.id, hidden: !o.hidden })}
            >
              {o.hidden ? '◌' : '●'}
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}

/** 속성 (블렌더 N 패널·속성 편집기): 위치·회전, 메시 통계, 편집 모드에선 고른 점의 중앙 */
export function ModelingProperties() {
  const model = useSceneStore(selectModel);
  const selectedId = useSceneStore((s) => s.selectedId);
  const mode = useModelingStore((s) => s.mode);
  const selVerts = useModelingStore((s) => s.selVerts);
  const obj = model.objects.find((o) => o.id === selectedId);
  if (!obj) return <section className="mprops" aria-label="속성"><h2>속성</h2><p className="empty">객체를 고르세요</p></section>;
  return (
    <section className="mprops" aria-label="속성" data-testid="modeling-properties">
      <h2>{obj.name}</h2>
      {mode === 'edit' && obj.kind === 'polymesh' ? <EditStats obj={obj} sel={selVerts} /> : <ObjectFields obj={obj} />}
    </section>
  );
}

function ObjectFields({ obj }: { obj: CadObject }) {
  const { submitNow } = useSceneStore.getState();
  const t = obj.transform;
  const setPos = (i: number, v: number) => {
    const p = [...t.position] as Vec3;
    p[i] = v;
    submitNow({ type: 'set_transform', target: obj.id, position: p });
  };
  const setRot = (i: number, v: number) => {
    const r = [...t.rotation] as Vec3;
    r[i] = v;
    submitNow({ type: 'set_transform', target: obj.id, rotation: r });
  };
  return (
    <>
      <h3>위치</h3>
      {(['X', 'Y', 'Z'] as const).map((a, i) => (
        <NumberField key={a} label={a} value={t.position[i]!} unit="mm" onCommit={(v) => setPos(i, v)} testId={`loc-${a.toLowerCase()}`} />
      ))}
      <h3>회전</h3>
      {(['X', 'Y', 'Z'] as const).map((a, i) => (
        <NumberField key={a} label={a} value={t.rotation[i]!} unit="°" onCommit={(v) => setRot(i, v)} testId={`rot-${a.toLowerCase()}`} />
      ))}
      {obj.kind === 'polymesh' && (
        <>
          <MeshStats obj={obj} />
          <ModifierStack obj={obj} />
        </>
      )}
    </>
  );
}

function MeshStats({ obj }: { obj: CadObject & { kind: 'polymesh' } }) {
  const m = obj.polymesh;
  const open = boundaryEdgeCount(m);
  return (
    <>
      <h3>메시</h3>
      <dl className="stats" data-testid="mesh-stats">
        <dt>점</dt>
        <dd>{m.verts.length}</dd>
        <dt>선</dt>
        <dd>{edges(m).length}</dd>
        <dt>면</dt>
        <dd>{m.faces.length}</dd>
        <dt>상태</dt>
        <dd title={open ? '열린 선이 있으면 3D 프린팅·불리언에 쓸 수 없습니다' : '닫힌 메시 — 내보내기·불리언 가능'}>{open ? `열림 (열린 선 ${open})` : '닫힘'}</dd>
      </dl>
    </>
  );
}

/** 편집 모드: 고른 개수 + 고른 점 중앙 (값을 고치면 그만큼 옮긴다 — 블렌더 "중앙") */
function EditStats({ obj, sel }: { obj: CadObject & { kind: 'polymesh' }; sel: number[] }) {
  const m = obj.polymesh;
  const s = useMemo(() => new Set(sel), [sel]);
  const nEdges = useMemo(() => edges(m).filter(([a, b]) => s.has(a) && s.has(b)).length, [m, s]);
  const nFaces = useMemo(() => selectedFaces(m, s).length, [m, s]);
  const c = sel.length ? centroid(m, sel) : null;
  const move = (i: number, v: number) => {
    if (!c) return;
    const d = [0, 0, 0];
    d[i] = v - c[i]!;
    const matrix = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, d[0]!, d[1]!, d[2]!, 1];
    useSceneStore.getState().submitNow({ type: 'mesh_edit', target: obj.id, edit: { op: 'transform', verts: sel, matrix } });
  };
  return (
    <>
      <p className="sel-count" data-testid="edit-selection">
        점 {sel.length}/{m.verts.length} · 선 {nEdges} · 면 {nFaces}/{m.faces.length}
      </p>
      {c ? (
        <>
          <h3>중앙 (객체 기준)</h3>
          {(['X', 'Y', 'Z'] as const).map((a, i) => (
            <NumberField key={a} label={a} value={Math.round(c[i]! * 1e4) / 1e4} unit="mm" onCommit={(v) => move(i, v)} testId={`median-${a.toLowerCase()}`} />
          ))}
        </>
      ) : (
        <p className="empty">클릭으로 점·선·면을 고르세요 (Shift = 더하기, A = 전체)</p>
      )}
      <MeshStats obj={obj} />
      <ModifierStack obj={obj} />
    </>
  );
}

/** Shift+A 추가 메뉴 (마우스 위치에 뜬다) */
export function AddMenu() {
  const at = useModelingStore((s) => s.addMenu);
  if (!at) return null;
  const close = () => useModelingStore.getState().setAddMenu(null);
  return (
    <div className="add-menu mmenu" role="menu" style={{ left: at[0], top: at[1] }} data-testid="add-menu" onMouseLeave={close}>
      <div className="menu-title">메시 추가</div>
      {ADD_MESH_ITEMS.map((i) => (
        <button key={i.primitive} role="menuitem" onClick={() => { addMesh(i.primitive); close(); }}>
          {i.label}
        </button>
      ))}
    </div>
  );
}

/** 아래 안내줄: 지금 할 수 있는 키 (블렌더 상태 표시줄처럼) — 모달 중에는 현재 값 */
export function ModelingHint() {
  const mode = useModelingStore((s) => s.mode);
  const modal = useModelingStore((s) => s.modal);
  const label = useModelingStore((s) => s.preview?.label);
  let text: string;
  if (mode === 'sculpt' && !modal)
    text = '스컬프트 모드 · 왼쪽 드래그: 브러시 · Shift: 매끈하게 · Ctrl: 반대로 · X 그리기 · I 부풀리기 · S 매끈하게 · G 잡아끌기 · Shift+T 평평하게 · [ ] 반지름 · Tab 편집 모드 · Esc 오브젝트 모드';
  else if (modal) text = `${label ?? ''} · X/Y/Z: 축 고정 · 숫자: 값 입력 · 클릭/Enter: 확정 · 오른쪽 클릭/Esc: 취소`;
  else if (mode === 'edit')
    text = '편집 모드 · 1/2/3 점·선·면 · 클릭 선택(Shift 더하기) · A 전체 · G/R/S · E 돌출 · I 인셋 · Ctrl+R 루프 컷 · X 삭제 · M 병합 · F 면 · Tab 나가기';
  else text = '오브젝트 모드 · 클릭 선택 · Shift+A 추가 · G 이동 · R 회전 · S 크기 · X 삭제 · Tab 편집 모드 · 가운데 드래그 회전 · Shift+가운데 이동 · 휠 확대';
  return (
    <div className="viewport-hint modeling-hint" data-testid="modeling-hint">
      {text}
    </div>
  );
}

/** 빈 장면 안내 */
export function ModelingEmptyGuide() {
  const model = useSceneStore(selectModel);
  if (model.objects.length) return null;
  return (
    <div className="start-guide modeling-guide" data-testid="modeling-start-guide">
      <strong>새 장면</strong>
      <p>Shift+A 로 메시를 추가하고, Tab 으로 편집 모드에 들어가 점·선·면을 고칩니다.</p>
      <div className="guide-buttons">
        {ADD_MESH_ITEMS.slice(1, 5).map((i) => (
          <button key={i.primitive} onClick={() => addMesh(i.primitive)} data-testid={`guide-add-${i.primitive}`}>
            + {i.label}
          </button>
        ))}
      </div>
    </div>
  );
}

type Mod = NonNullable<(CadObject & { kind: 'polymesh' })['modifiers']>[number];
const NEW_MODIFIER: Record<Mod['type'], Mod> = {
  subsurf: { type: 'subsurf', levels: 1 },
  mirror: { type: 'mirror', axis: 'x', merge: true },
  array: { type: 'array', count: 3, offset: [30, 0, 0] },
  solidify: { type: 'solidify', thickness: 2 },
};

/** 모디파이어 스택 (블렌더 속성 편집기의 렌치 탭): 위에서부터 적용. 추가·값·순서·삭제·적용, 부드러운 음영 */
export function ModifierStack({ obj }: { obj: CadObject & { kind: 'polymesh' } }) {
  const mods = obj.modifiers ?? [];
  const { submitNow } = useSceneStore.getState();
  const set = (next: Mod[]) => submitNow({ type: 'set_modifiers', target: obj.id, modifiers: next });
  const patch = (i: number, m: Mod) => set(mods.map((x, k) => (k === i ? m : x)));
  const move = (i: number, d: -1 | 1) => {
    const next = [...mods];
    [next[i], next[i + d]] = [next[i + d]!, next[i]!];
    set(next);
  };
  return (
    <div className="modifiers" data-testid="modifier-stack">
      <h3>
        모디파이어
        <select
          aria-label="모디파이어 추가"
          data-testid="modifier-add"
          value=""
          onChange={(e) => e.target.value && set([...mods, NEW_MODIFIER[e.target.value as Mod['type']]])}
        >
          <option value="">+ 추가</option>
          {(Object.keys(NEW_MODIFIER) as Mod['type'][]).map((t) => (
            <option key={t} value={t}>
              {MODIFIER_LABEL[t]}
            </option>
          ))}
        </select>
      </h3>
      {mods.map((m, i) => (
        <div className="modifier" key={i} data-testid={`modifier-${i}`}>
          <div className="modifier-head">
            <b>{MODIFIER_LABEL[m.type]}</b>
            <span className="spacer" />
            <button disabled={i === 0} onClick={() => move(i, -1)} title="위로">↑</button>
            <button disabled={i === mods.length - 1} onClick={() => move(i, 1)} title="아래로">↓</button>
            {i === 0 && (
              <button onClick={() => submitNow({ type: 'apply_modifier', target: obj.id })} title="메시에 굳히기 (맨 위만)" data-testid="modifier-apply">
                적용
              </button>
            )}
            <button onClick={() => set(mods.filter((_, k) => k !== i))} title="삭제" data-testid={`modifier-remove-${i}`}>✕</button>
          </div>
          {m.type === 'subsurf' && (
            <NumberField label="단계" value={m.levels} unit="개" onCommit={(v) => patch(i, { ...m, levels: Math.max(1, Math.min(3, Math.round(v))) })} testId={`mod-${i}-levels`} />
          )}
          {m.type === 'mirror' && (
            <div className="field">
              <label>축</label>
              <div className="seg-inline">
                {(['x', 'y', 'z'] as const).map((a) => (
                  <button key={a} aria-pressed={m.axis === a} onClick={() => patch(i, { ...m, axis: a })}>
                    {a.toUpperCase()}
                  </button>
                ))}
                <label className="check">
                  <input type="checkbox" checked={m.merge} onChange={(e) => patch(i, { ...m, merge: e.target.checked })} /> 합치기
                </label>
              </div>
            </div>
          )}
          {m.type === 'array' && (
            <>
              <NumberField label="개수" value={m.count} unit="개" onCommit={(v) => patch(i, { ...m, count: Math.max(2, Math.min(50, Math.round(v))) })} testId={`mod-${i}-count`} />
              {(['X', 'Y', 'Z'] as const).map((a, k) => (
                <NumberField
                  key={a}
                  label={`간격 ${a}`}
                  value={m.offset[k]!}
                  unit="mm"
                  onCommit={(v) => {
                    const o = [...m.offset] as [number, number, number];
                    o[k] = v;
                    patch(i, { ...m, offset: o });
                  }}
                />
              ))}
            </>
          )}
          {m.type === 'solidify' && (
            <NumberField label="두께" value={m.thickness} unit="mm" onCommit={(v) => patch(i, { ...m, thickness: Math.max(0.01, v) })} testId={`mod-${i}-thickness`} />
          )}
        </div>
      ))}
      {mods.length > 1 && (
        <button className="apply-all" onClick={() => submitNow({ type: 'apply_modifier', target: obj.id, all: true })}>
          모두 적용
        </button>
      )}
      <div className="field">
        <label>음영</label>
        <div className="seg-inline">
          <button aria-pressed={!obj.smooth} onClick={() => obj.smooth && submitNow({ type: 'set_shading', target: obj.id, smooth: false })} data-testid="shade-flat">
            각지게
          </button>
          <button aria-pressed={!!obj.smooth} onClick={() => !obj.smooth && submitNow({ type: 'set_shading', target: obj.id, smooth: true })} data-testid="shade-smooth">
            부드럽게
          </button>
        </div>
      </div>
    </div>
  );
}
