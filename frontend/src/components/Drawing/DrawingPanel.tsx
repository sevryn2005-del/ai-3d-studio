/**
 * 도면 창: 현재 모델을 3각법 도면(정면·평면·우측면·등각)으로. 엔진이 숨은선을 지운 투상선을 주고,
 * 시트(features/drawing/sheet.ts)가 배치·척도·자동 치수·표제란을 만든다. SVG·DXF 저장, 인쇄(PDF 로 저장)는 모두 로컬.
 * 도면 설정(용지·척도·보기·단면·주기)은 설계 원본 model.drawing 에 set_drawing 명령으로 저장된다 (실행 취소·프로젝트 저장).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { DEFAULT_DRAWING, MAX_DRAWING_DETAILS, type DrawingDim, type DrawingSettings } from '../../cad/commandTypes';
import { DIM_KIND_LABEL, dimOffsetAt, makeAnchor, parseTol, snapCircle, snapVertex, tolInput } from '../../features/drawing/dims';
import { create } from 'zustand';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { getActiveEngine, useActiveEngineId } from '../../features/engine/engines';
import type { DrawingView, DrawingViewName } from '../../features/engine/types';
import { sheetToDxf, sheetToSvg } from '../../features/drawing/exportSheet';
import { buildSheet, DETAIL_LABELS, dimText, PAPERS, scaleLabel, STANDARD_SCALES, tolText, type Paper } from '../../features/drawing/sheet';
import { ALL_VIEWS, DRAWING_VIEWS } from '../../features/drawing/views';
import { downloadBlob } from '../../features/projects/projectStorage';
import { useProjectStore } from '../../features/projects/projectStore';

interface DrawingState {
  open: boolean;
  setOpen: (open: boolean) => void;
}
export const useDrawingStore = create<DrawingState>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

type PickView = 'front' | 'top' | 'right';
/** 고르기 허용 거리 (종이 mm) */
const PICK_MM = 3;

const today = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export function DrawingPanel() {
  const open = useDrawingStore((s) => s.open);
  return open ? <DrawingWindow /> : null;
}

function DrawingWindow() {
  const model = useSceneStore(selectModel);
  const submitNow = useSceneStore((s) => s.submitNow);
  const engineId = useActiveEngineId();
  const projectName = useProjectStore((s) => s.name);
  const close = () => useDrawingStore.getState().setOpen(false);
  // 설정은 설계 원본(model.drawing)에 — 바꿀 때마다 set_drawing 명령 (실행 취소·저장·AI 가 같은 경로)
  const settings: DrawingSettings = model.drawing ?? DEFAULT_DRAWING;
  const update = (patch: Partial<DrawingSettings>) => {
    const next = { ...settings, ...patch };
    if (!next.section) delete next.section;
    if (!next.details?.length) delete next.details;
    submitNow({ type: 'set_drawing', drawing: next });
  };
  const title = settings.title ?? projectName;
  const [titleDraft, setTitleDraft] = useState(title);
  const [notesDraft, setNotesDraft] = useState(settings.notes ?? '');
  useEffect(() => setTitleDraft(title), [title]);
  useEffect(() => setNotesDraft(settings.notes ?? ''), [settings.notes]);
  const chosen = settings.views;
  const [views, setViews] = useState<DrawingView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // 도면 설정만 바뀌면 형상을 다시 투상하지 않는다
  const geometry = useMemo(() => ({ ...model, drawing: undefined }), [model.objects, model.sketches, model.mates]); // eslint-disable-line react-hooks/exhaustive-deps
  const sectionKey = JSON.stringify(settings.section ?? null);

  // 형상·엔진·보기·단면이 바뀌면 다시 투상 (늦게 온 결과는 버린다)
  useEffect(() => {
    const engine = engineId ? getActiveEngine(engineId) : null;
    if (!engine || !chosen.length) return;
    const ctl = new AbortController();
    setBusy(true);
    setError(null);
    engine
      .drawing(geometry, chosen, settings.section, ctl.signal)
      .then((v) => {
        if (ctl.signal.aborted) return;
        setViews(v);
        setBusy(false);
      })
      .catch((e: Error) => {
        if (ctl.signal.aborted) return;
        setViews(null);
        setError(e.message);
        setBusy(false);
      });
    return () => ctl.abort();
  }, [geometry, engineId, chosen.join(','), sectionKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 치수 추가 모드: 종류 → 끝점 클릭(꼭짓점에 붙음) → 치수선 위치 클릭. Esc 는 모드를 먼저 끝낸다
  const [dimMode, setDimMode] = useState<DrawingDim['kind'] | 'detail' | null>(null);
  const [pending, setPending] = useState<{ view: PickView; p: [number, number] }[]>([]);
  const [hover, setHover] = useState<{ view: PickView; p: [number, number]; paper: [number, number]; r?: number } | null>(null);
  const modeRef = useRef(dimMode);
  modeRef.current = dimMode;
  useEffect(() => {
    const key = (ev: KeyboardEvent) => {
      if (ev.key !== 'Escape' || ev.target instanceof HTMLTextAreaElement) return;
      if (modeRef.current) {
        setDimMode(null);
        setPending([]);
        setHover(null);
      } else close();
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  // 치수 끌어 옮기기: 끄는 동안은 화면에서만 간격을 바꿔 보여 주고, 놓을 때 set_drawing 하나 (실행 취소 1번)
  const [drag, setDrag] = useState<{ id: string; offset: number } | null>(null);
  const shownDims = drag && settings.dims ? settings.dims.map((d) => (d.id === drag.id ? { ...d, offset: drag.offset } : d)) : settings.dims;
  const sheet = useMemo(
    () =>
      views && chosen.length
        ? buildSheet(views, {
            paper: settings.paper,
            scale: settings.scale,
            title,
            date: today(),
            dimensions: settings.dimensions,
            centerlines: settings.centerlines,
            ...(settings.section ? { section: settings.section } : {}),
            ...(settings.notes ? { notes: settings.notes } : {}),
            ...(shownDims?.length ? { dims: shownDims } : {}),
            ...(settings.details?.length ? { details: settings.details } : {}),
          })
        : null,
    [views, chosen.length, settings, title, shownDims],
  );
  const svg = useMemo(() => (sheet ? sheetToSvg(sheet) : ''), [sheet]);
  const fileBase = `${title || projectName} 도면`;
  const [W, H] = PAPERS[settings.paper];
  const toggle = (v: DrawingViewName) => update({ views: chosen.includes(v) ? chosen.filter((x) => x !== v) : ALL_VIEWS.filter((x) => x === v || chosen.includes(x)) });
  /** 단면 위치 기본값: 형상 가운데 (정면 단면 = 평면도의 y 가운데, 우측면 단면 = 정면도의 x 가운데) */
  const sectionCenter = (view: 'front' | 'right') => {
    const ref = views?.find((v) => v.name === (view === 'front' ? 'top' : 'front'));
    return ref ? Math.round(((view === 'front' ? ref.bounds[1] + ref.bounds[3] : ref.bounds[0] + ref.bounds[2]) / 2) * 1000) / 1000 : 0;
  };
  const dims = settings.dims ?? [];
  const viewOf = (name: PickView) => views?.find((v) => v.name === name);
  /** 화면 → 종이 → 보기. 보기 배치 밖(6mm 여유)이면 null */
  const pick = (ev: React.MouseEvent<SVGSVGElement>) => {
    if (!sheet) return null;
    const r = ev.currentTarget.getBoundingClientRect();
    const paper: [number, number] = [((ev.clientX - r.left) / r.width) * sheet.width, sheet.height - ((ev.clientY - r.top) / r.height) * sheet.height];
    for (const name of ['front', 'top', 'right'] as const) {
      const pl = sheet.placements[name];
      const v = viewOf(name);
      if (!pl || !v) continue;
      const w = (pl.bounds[2] - pl.bounds[0]) * pl.scale;
      const h = (pl.bounds[3] - pl.bounds[1]) * pl.scale;
      if (paper[0] < pl.at[0] - 6 || paper[0] > pl.at[0] + w + 6 || paper[1] < pl.at[1] - 6 || paper[1] > pl.at[1] + h + 6) continue;
      const p: [number, number] = [pl.bounds[0] + (paper[0] - pl.at[0]) / pl.scale, pl.bounds[1] + (paper[1] - pl.at[1]) / pl.scale];
      return { view: name, v, pl, paper, p, tol: PICK_MM / pl.scale };
    }
    return { view: null, paper } as const;
  };
  const eventPaper = (ev: React.PointerEvent<SVGElement>): [number, number] => {
    const svgEl = (ev.currentTarget as SVGElement).ownerSVGElement ?? (ev.currentTarget as SVGSVGElement);
    const r = svgEl.getBoundingClientRect();
    return [((ev.clientX - r.left) / r.width) * sheet!.width, sheet!.height - ((ev.clientY - r.top) / r.height) * sheet!.height];
  };
  const dragTo = (ev: React.PointerEvent<SVGElement>, id: string) => {
    const h = sheet?.dimHandles.find((x) => x.id === id);
    if (!h) return null;
    return dimOffsetAt(h.kind, h.A, h.B, eventPaper(ev));
  };
  const toPaper = (view: PickView, p: [number, number]): [number, number] => {
    const pl = sheet!.placements[view]!;
    return [pl.at[0] + (p[0] - pl.bounds[0]) * pl.scale, pl.at[1] + (p[1] - pl.bounds[1]) * pl.scale];
  };
  const nextDimId = () => {
    let n = 1;
    while (dims.some((d) => d.id === `dim${n}`)) n++;
    return `dim${n}`;
  };
  const details = settings.details ?? [];
  const nextDetailId = () => {
    let n = 1;
    while (details.some((d) => d.id === `detail${n}`)) n++;
    return `detail${n}`;
  };
  const onMove = (ev: React.MouseEvent<SVGSVGElement>) => {
    const h = pick(ev);
    if (!h || !dimMode) return setHover(null);
    if (dimMode === 'detail') {
      // 상세도: 첫 클릭 = 가운데, 둘째 = 반지름 (원 미리보기)
      if (pending.length === 1) {
        const c = toPaper(pending[0]!.view, pending[0]!.p);
        return setHover({ view: pending[0]!.view, p: [0, 0], paper: c, r: Math.hypot(h.paper[0] - c[0], h.paper[1] - c[1]) });
      }
      return setHover(h.view ? { view: h.view, p: h.p, paper: h.paper } : null);
    }
    // 치수선 자리: 보기 밖이어도 된다
    if (pending.length === 2 && dimMode !== 'diameter') return setHover({ view: pending[0]!.view, p: [0, 0], paper: h.paper });
    if (!h.view) return setHover(null);
    if (dimMode === 'diameter') {
      const c = snapCircle(h.v, h.p, h.tol);
      return setHover(c ? { view: h.view, p: c.center, paper: toPaper(h.view, c.center), r: c.radius * h.pl.scale } : null);
    }
    const q = snapVertex(h.v, h.p, h.tol);
    setHover(q ? { view: h.view, p: q, paper: toPaper(h.view, q) } : null);
  };
  const onClick = (ev: React.MouseEvent<SVGSVGElement>) => {
    const h = pick(ev);
    if (!h || !dimMode) return;
    if (dimMode === 'detail') {
      if (pending.length === 0) {
        if (h.view) setPending([{ view: h.view, p: h.p }]);
        return;
      }
      const c = pending[0]!;
      const cp = toPaper(c.view, c.p);
      const scale = sheet!.placements[c.view]!.scale;
      const radius = Math.round((Math.hypot(h.paper[0] - cp[0], h.paper[1] - cp[1]) / scale) * 100) / 100;
      setPending([]);
      setDimMode(null);
      setHover(null);
      if (radius < 0.01 || details.length >= MAX_DRAWING_DETAILS) return;
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      update({ details: [...details, { id: nextDetailId(), view: c.view, center: [r3(c.p[0]), r3(c.p[1])], radius, scale: 2 }] });
      return;
    }
    if (pending.length === 2 && dimMode !== 'diameter') return placeDim(h.paper);
    if (!h.view) return;
    if (dimMode === 'diameter') {
      const c = snapCircle(h.v, h.p, h.tol);
      if (!c) return;
      update({ dims: [...dims, { id: nextDimId(), view: h.view, kind: 'diameter', a: makeAnchor(h.v, c.center), offset: 8 }] });
      return;
    }
    if (pending.length === 1 && pending[0]!.view !== h.view) return; // 두 끝점은 같은 보기에서
    const q = snapVertex(h.v, h.p, h.tol);
    if (q) setPending([...pending, { view: h.view, p: q }]);
  };
  /** 세 번째 클릭: 치수선 위치 (종이 mm, 부호 = 방향) */
  const placeDim = (P: [number, number]) => {
    if (!dimMode || dimMode === 'diameter' || dimMode === 'detail') return;
    const [a, b] = pending as [{ view: PickView; p: [number, number] }, { view: PickView; p: [number, number] }];
    const offset = dimOffsetAt(dimMode, toPaper(a.view, a.p), toPaper(b.view, b.p), P);
    const v = viewOf(a.view)!;
    update({ dims: [...dims, { id: nextDimId(), view: a.view, kind: dimMode, a: makeAnchor(v, a.p), b: makeAnchor(v, b.p), offset }] });
    setPending([]);
  };
  const setDimTol = (id: string, tol: DrawingDim['tol']) =>
    update({ dims: dims.map((d) => (d.id !== id ? d : tol ? { ...d, tol } : (({ tol: _drop, ...rest }) => rest)(d))) });
  const setDimOffset = (id: string, offset: number) => update({ dims: dims.map((d) => (d.id === id ? { ...d, offset: Math.max(-200, Math.min(200, offset)) } : d)) });
  const removeDim = (id: string) => update({ dims: dims.filter((d) => d.id !== id) });
  const resolved = new Map((sheet?.dims ?? []).map((r) => [r.dim.id, r]));

  const commitText = () => {
    const patch: Partial<DrawingSettings> = {};
    if (titleDraft !== title) patch.title = titleDraft.slice(0, 80);
    if (notesDraft !== (settings.notes ?? '')) patch.notes = notesDraft.slice(0, 500);
    if (Object.keys(patch).length) update(patch);
  };

  return (
    <div className="drawing-window" role="dialog" aria-label="도면" data-testid="drawing-window">
      {/* 인쇄: 시트만, 용지 크기 그대로 (브라우저 인쇄에서 'PDF 로 저장' 가능) */}
      <style>{`@media print { @page { size: ${W}mm ${H}mm; margin: 0 } .drawing-print svg { width: ${W}mm !important; height: ${H}mm !important } }`}</style>
      <aside className="drawing-options">
        <div className="pm-head">
          <strong>도면</strong>
          <button className="cancel" onClick={close} data-testid="drawing-close" title="닫기 (Esc)">
            ✕
          </button>
        </div>
        <label className="drawing-field">
          <span>제목</span>
          <input
            value={titleDraft}
            maxLength={80}
            onChange={(e) => setTitleDraft(e.target.value)}
            onBlur={commitText}
            onKeyDown={(e) => e.key === 'Enter' && commitText()}
            data-testid="drawing-title"
          />
        </label>
        <label className="drawing-field">
          <span>용지</span>
          <select value={settings.paper} onChange={(e) => update({ paper: e.target.value as Paper })} data-testid="drawing-paper">
            {(Object.keys(PAPERS) as Paper[]).map((p) => (
              <option key={p} value={p}>
                {p} 가로 ({PAPERS[p][0]}×{PAPERS[p][1]})
              </option>
            ))}
          </select>
        </label>
        <label className="drawing-field">
          <span>척도</span>
          <select value={String(settings.scale)} onChange={(e) => update({ scale: e.target.value === 'auto' ? 'auto' : Number(e.target.value) })} data-testid="drawing-scale">
            <option value="auto">자동{sheet && settings.scale === 'auto' ? ` (${scaleLabel(sheet.scale)})` : ''}</option>
            {STANDARD_SCALES.map((s) => (
              <option key={s} value={String(s)}>
                {scaleLabel(s)}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="drawing-views">
          <legend>보기 (3각법)</legend>
          {ALL_VIEWS.map((v) => (
            <label key={v} className="check">
              <input type="checkbox" checked={chosen.includes(v)} onChange={() => toggle(v)} data-testid={`drawing-view-${v}`} />
              {DRAWING_VIEWS[v].label}
            </label>
          ))}
        </fieldset>
        <label className="check">
          <input type="checkbox" checked={settings.dimensions} onChange={(e) => update({ dimensions: e.target.checked })} data-testid="drawing-dims" />
          자동 치수 (전체 크기·구멍 지름)
        </label>
        <label className="check">
          <input type="checkbox" checked={settings.centerlines} onChange={(e) => update({ centerlines: e.target.checked })} data-testid="drawing-centerlines" />
          중심선 (원 중심·원통 축)
        </label>
        <label className="drawing-field">
          <span>단면도 (전단면 A-A)</span>
          <select
            value={settings.section?.view ?? ''}
            onChange={(e) => {
              const view = e.target.value as '' | 'front' | 'right';
              update({ section: view ? { view, offset: settings.section?.view === view ? settings.section.offset : sectionCenter(view) } : undefined });
            }}
            data-testid="drawing-section"
          >
            <option value="">없음</option>
            <option value="front">정면도를 단면으로 (앞쪽을 걷어냄)</option>
            <option value="right">우측면도를 단면으로 (오른쪽을 걷어냄)</option>
          </select>
        </label>
        {settings.section && (
          <label className="drawing-field">
            <span>자르는 위치 ({settings.section.view === 'front' ? 'Y' : 'X'}, mm)</span>
            <input
              type="number"
              step="any"
              key={settings.section.offset}
              defaultValue={settings.section.offset}
              onBlur={(e) => {
                const v = Number(e.target.value);
                if (Number.isFinite(v) && v !== settings.section!.offset) update({ section: { ...settings.section!, offset: v } });
              }}
              onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
              data-testid="drawing-section-offset"
            />
          </label>
        )}
        <label className="drawing-field">
          <span>주기 (표제란 옆, 최대 6줄)</span>
          <textarea rows={3} maxLength={500} value={notesDraft} onChange={(e) => setNotesDraft(e.target.value)} onBlur={commitText} data-testid="drawing-notes" placeholder="예: 지시 없는 모따기 C0.5" />
        </label>
        {sheet?.overflow && <p className="warn small">고른 척도로는 용지에 다 들어가지 않습니다</p>}
        <div className="drawing-actions">
          <button disabled={!sheet} onClick={() => sheet && void downloadBlob(new Blob([svg], { type: 'image/svg+xml' }), `${fileBase}.svg`)} data-testid="drawing-svg">
            SVG 저장
          </button>
          <button disabled={!sheet} onClick={() => sheet && void downloadBlob(new Blob([sheetToDxf(sheet)], { type: 'application/dxf' }), `${fileBase}.dxf`)} data-testid="drawing-dxf" title="다른 CAD 에서 여는 2D 도면 (DXF R12)">
            DXF 저장
          </button>
          <button disabled={!sheet} onClick={() => window.print()} data-testid="drawing-print" title="인쇄 창에서 'PDF 로 저장'을 고르면 PDF 파일이 됩니다">
            인쇄 · PDF
          </button>
        </div>
        <fieldset className="drawing-dims">
          <legend>치수 추가 (클릭)</legend>
          <div className="drawing-dim-kinds">
            {(['horizontal', 'vertical', 'aligned', 'diameter'] as const).map((k) => (
              <button
                key={k}
                aria-pressed={dimMode === k}
                onClick={() => {
                  setDimMode(dimMode === k ? null : k);
                  setPending([]);
                }}
                data-testid={`dim-mode-${k}`}
              >
                {DIM_KIND_LABEL[k]}
              </button>
            ))}
          </div>
          {dimMode && (
            <p className="muted small" data-testid="dim-hint">
              {dimMode === 'detail'
                ? pending.length === 0
                  ? '확대할 곳의 가운데를 클릭하세요 (정면·평면·우측면도)'
                  : '원 크기를 정할 곳을 클릭하세요'
                : dimMode === 'diameter'
                ? '원(가장자리·중심)을 클릭하세요'
                : pending.length === 0
                  ? '첫 꼭짓점을 클릭하세요 (가까운 꼭짓점에 붙음)'
                  : pending.length === 1
                    ? '둘째 꼭짓점을 클릭하세요 (같은 보기)'
                    : '치수선을 놓을 자리를 클릭하세요'}
              {' · Esc: 끝내기'}
            </p>
          )}
          {dims.length > 0 && (
            <ul className="drawing-dim-list">
              {dims.map((d) => {
                const r = resolved.get(d.id);
                return (
                  <li key={d.id} data-testid={`dim-row-${d.id}`} className={r && !r.ok ? 'broken' : undefined}>
                    <span>
                      {DIM_KIND_LABEL[d.kind]} · {DRAWING_VIEWS[d.view].label}{' '}
                      <strong data-testid={`dim-value-${d.id}`}>{r ? (r.ok ? `${d.kind === 'diameter' ? 'Ø' : ''}${dimText(r.value)}${tolText(d.tol)}` : '연결 끊김') : '보기 없음'}</strong>
                    </span>
                    <input
                      type="number"
                      step="any"
                      aria-label={`${d.id} 간격 (종이 mm)`}
                      title="치수선까지 간격 (종이 mm, 부호 = 방향)"
                      key={`${d.id}:${d.offset}`}
                      defaultValue={d.offset}
                      onBlur={(e) => {
                        const v = Number(e.target.value);
                        if (Number.isFinite(v) && v !== d.offset) setDimOffset(d.id, v);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      data-testid={`dim-offset-${d.id}`}
                    />
                    <input
                      className="dim-tol"
                      aria-label={`${d.id} 공차`}
                      title="공차: ±0.1 또는 +0.1/-0.05 (비우면 없음)"
                      placeholder="공차"
                      key={`${d.id}:tol:${tolInput(d.tol)}`}
                      defaultValue={tolInput(d.tol)}
                      onBlur={(e) => {
                        const t = parseTol(e.target.value);
                        if (t === null) {
                          e.target.value = tolInput(d.tol);
                          return;
                        }
                        if (tolInput(t) !== tolInput(d.tol)) setDimTol(d.id, t);
                      }}
                      onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
                      data-testid={`dim-tol-${d.id}`}
                    />
                    <button className="cancel" onClick={() => removeDim(d.id)} title="치수 지우기" data-testid={`dim-delete-${d.id}`}>
                      ✕
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </fieldset>
        <fieldset className="drawing-dims">
          <legend>상세도 (부분 확대)</legend>
          <button
            aria-pressed={dimMode === 'detail'}
            disabled={details.length >= MAX_DRAWING_DETAILS}
            onClick={() => {
              setDimMode(dimMode === 'detail' ? null : 'detail');
              setPending([]);
            }}
            data-testid="detail-mode"
            title="보기에서 가운데·크기를 클릭해 원 영역을 고르면, 그 부분을 확대한 그림을 빈 자리에 넣습니다 (최대 4개)"
          >
            + 상세도
          </button>
          {details.length > 0 && (
            <ul className="drawing-dim-list">
              {details.map((d, k) => (
                <li key={d.id} data-testid={`detail-row-${d.id}`}>
                  <span>
                    상세 {DETAIL_LABELS[k]} · {DRAWING_VIEWS[d.view].label}
                  </span>
                  <select
                    value={String(d.scale)}
                    aria-label={`${d.id} 배율`}
                    title="시트 척도의 몇 배로 확대할지"
                    onChange={(e) => update({ details: details.map((x) => (x.id === d.id ? { ...x, scale: Number(e.target.value) } : x)) })}
                    data-testid={`detail-scale-${d.id}`}
                  >
                    {[...new Set([1.5, 2, 2.5, 3, 4, 5, 10, d.scale])].sort((a, b) => a - b).map((s) => (
                      <option key={s} value={String(s)}>
                        ×{s}
                      </option>
                    ))}
                  </select>
                  <button className="cancel" onClick={() => update({ details: details.filter((x) => x.id !== d.id) })} title="상세도 지우기" data-testid={`detail-delete-${d.id}`}>
                    ✕
                  </button>
                </li>
              ))}
            </ul>
          )}
        </fieldset>
        <p className="muted small">숨은선은 파선, 접선 모서리는 그리지 않습니다. 숨긴 객체는 도면에서 빠집니다. 추가한 치수는 모델을 고치면 가까운 꼭짓점에 다시 붙고, 붙을 곳이 없으면 "?" 로 표시됩니다.</p>
      </aside>
      <div className="drawing-paper" data-testid="drawing-paper-area" data-busy={busy}>
        {error && (
          <p className="drawing-message" role="alert">
            {error}
          </p>
        )}
        {!error && !chosen.length && <p className="drawing-message">보기를 하나 이상 고르세요</p>}
        {!error && chosen.length > 0 && !sheet && <p className="drawing-message">도면을 계산하는 중…</p>}
        {/* 글자는 sheetToSvg 가 이스케이프한다 */}
        {sheet && !error && (
          <div className="drawing-sheet-wrap">
            <div className="drawing-sheet drawing-print" data-testid="drawing-sheet" data-scale={sheet.scale} dangerouslySetInnerHTML={{ __html: svg }} />
            {/* 치수 고르기: 같은 종이 좌표의 투명 층 (인쇄·저장에는 들어가지 않음) */}
            <svg
              className="drawing-pick"
              data-testid="drawing-pick"
              data-mode={dimMode ?? ''}
              data-placements={JSON.stringify(sheet.placements)}
              data-paper={`${sheet.width},${sheet.height}`}
              viewBox={`0 0 ${sheet.width} ${sheet.height}`}
              style={{ pointerEvents: dimMode ? 'auto' : 'none', cursor: dimMode ? 'crosshair' : undefined }}
              onMouseMove={onMove}
              onMouseLeave={() => setHover(null)}
              onClick={onClick}
            >
              {pending.map((q, i) => {
                const [x, y] = toPaper(q.view, q.p);
                return <circle key={i} cx={x} cy={sheet.height - y} r={1.2} className="pick-done" />;
              })}
              {pending.length > 0 && hover && (() => {
                const [x0, y0] = toPaper(pending[pending.length - 1]!.view, pending[pending.length - 1]!.p);
                return <line x1={x0} y1={sheet.height - y0} x2={hover.paper[0]} y2={sheet.height - hover.paper[1]} className="pick-line" />;
              })()}
              {hover && <circle cx={hover.paper[0]} cy={sheet.height - hover.paper[1]} r={hover.r ?? 1.5} className="pick-hover" />}
              {/* 치수 손잡이: 모드가 없을 때 치수선 가운데(지름은 꺾인 곳)를 끌어 옮긴다 */}
              {!dimMode &&
                sheet.dimHandles.map((h) => (
                  <circle
                    key={h.id}
                    cx={h.handle[0]}
                    cy={sheet.height - h.handle[1]}
                    r={2.2}
                    className={`dim-handle${drag?.id === h.id ? ' dragging' : ''}`}
                    data-testid={`dim-handle-${h.id}`}
                    style={{ pointerEvents: 'auto', cursor: 'move' }}
                    onPointerDown={(ev) => {
                      ev.stopPropagation();
                      (ev.currentTarget as SVGElement).setPointerCapture(ev.pointerId);
                      const d = dims.find((x) => x.id === h.id);
                      if (d) setDrag({ id: h.id, offset: d.offset });
                    }}
                    onPointerMove={(ev) => {
                      if (drag?.id !== h.id) return;
                      const o = dragTo(ev, h.id);
                      if (o !== null && o !== drag.offset) setDrag({ id: h.id, offset: o });
                    }}
                    onPointerUp={() => {
                      if (drag?.id !== h.id) return;
                      const d = dims.find((x) => x.id === h.id);
                      setDrag(null);
                      if (d && d.offset !== drag.offset) setDimOffset(h.id, drag.offset);
                    }}
                  >
                    <title>끌어서 치수선 옮기기</title>
                  </circle>
                ))}
            </svg>
          </div>
        )}
      </div>
    </div>
  );
}
