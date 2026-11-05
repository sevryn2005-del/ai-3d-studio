/**
 * 도면 창: 현재 모델을 3각법 도면(정면·평면·우측면·등각)으로. 엔진이 숨은선을 지운 투상선을 주고,
 * 시트(features/drawing/sheet.ts)가 배치·척도·자동 치수·표제란을 만든다. SVG·DXF 저장, 인쇄(PDF 로 저장)는 모두 로컬.
 * 도면 설정(용지·척도·보기·단면·주기)은 설계 원본 model.drawing 에 set_drawing 명령으로 저장된다 (실행 취소·프로젝트 저장).
 */
import { useEffect, useMemo, useState } from 'react';
import { DEFAULT_DRAWING, type DrawingSettings } from '../../cad/commandTypes';
import { create } from 'zustand';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { getActiveEngine, useActiveEngineId } from '../../features/engine/engines';
import type { DrawingView, DrawingViewName } from '../../features/engine/types';
import { sheetToDxf, sheetToSvg } from '../../features/drawing/exportSheet';
import { buildSheet, PAPERS, scaleLabel, STANDARD_SCALES, type Paper } from '../../features/drawing/sheet';
import { ALL_VIEWS, DRAWING_VIEWS } from '../../features/drawing/views';
import { downloadBlob } from '../../features/projects/projectStorage';
import { useProjectStore } from '../../features/projects/projectStore';

interface DrawingState {
  open: boolean;
  setOpen: (open: boolean) => void;
}
export const useDrawingStore = create<DrawingState>((set) => ({ open: false, setOpen: (open) => set({ open }) }));

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

  useEffect(() => {
    const key = (ev: KeyboardEvent) => ev.key === 'Escape' && !(ev.target instanceof HTMLTextAreaElement) && close();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

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
          })
        : null,
    [views, chosen.length, settings, title],
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
        <p className="muted small">숨은선은 파선, 접선 모서리는 그리지 않습니다. 숨긴 객체는 도면에서 빠집니다.</p>
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
        {sheet && !error && <div className="drawing-sheet drawing-print" data-testid="drawing-sheet" data-scale={sheet.scale} dangerouslySetInnerHTML={{ __html: svg }} />}
      </div>
    </div>
  );
}
