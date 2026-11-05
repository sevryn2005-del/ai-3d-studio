/**
 * 도면 창: 현재 모델을 3각법 도면(정면·평면·우측면·등각)으로. 엔진이 숨은선을 지운 투상선을 주고,
 * 시트(features/drawing/sheet.ts)가 배치·척도·자동 치수·표제란을 만든다. SVG·DXF 저장, 인쇄(PDF 로 저장)는 모두 로컬.
 * 설계 원본은 바꾸지 않는다 (읽기 전용 결과물).
 */
import { useEffect, useMemo, useState } from 'react';
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
  const engineId = useActiveEngineId();
  const projectName = useProjectStore((s) => s.name);
  const close = () => useDrawingStore.getState().setOpen(false);
  const [paper, setPaper] = useState<Paper>('A4');
  const [scale, setScale] = useState<number | 'auto'>('auto');
  const [dimensions, setDimensions] = useState(true);
  const [title, setTitle] = useState(projectName);
  const [chosen, setChosen] = useState<DrawingViewName[]>([...ALL_VIEWS]);
  const [views, setViews] = useState<DrawingView[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // 모델·엔진·보기 선택이 바뀌면 다시 투상 (늦게 온 결과는 버린다)
  useEffect(() => {
    const engine = engineId ? getActiveEngine(engineId) : null;
    if (!engine) return;
    const ctl = new AbortController();
    setBusy(true);
    setError(null);
    engine
      .drawing(model, chosen, ctl.signal)
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
  }, [model, engineId, chosen]);

  useEffect(() => {
    const key = (ev: KeyboardEvent) => ev.key === 'Escape' && close();
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, []);

  const sheet = useMemo(() => (views && chosen.length ? buildSheet(views, { paper, scale, title, date: today(), dimensions }) : null), [views, chosen, paper, scale, title, dimensions]);
  const svg = useMemo(() => (sheet ? sheetToSvg(sheet) : ''), [sheet]);
  const fileBase = `${title || projectName} 도면`;
  const [W, H] = PAPERS[paper];
  const toggle = (v: DrawingViewName) => setChosen((c) => (c.includes(v) ? c.filter((x) => x !== v) : ALL_VIEWS.filter((x) => x === v || c.includes(x))));

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
          <input value={title} onChange={(e) => setTitle(e.target.value)} data-testid="drawing-title" />
        </label>
        <label className="drawing-field">
          <span>용지</span>
          <select value={paper} onChange={(e) => setPaper(e.target.value as Paper)} data-testid="drawing-paper">
            {(Object.keys(PAPERS) as Paper[]).map((p) => (
              <option key={p} value={p}>
                {p} 가로 ({PAPERS[p][0]}×{PAPERS[p][1]})
              </option>
            ))}
          </select>
        </label>
        <label className="drawing-field">
          <span>척도</span>
          <select value={String(scale)} onChange={(e) => setScale(e.target.value === 'auto' ? 'auto' : Number(e.target.value))} data-testid="drawing-scale">
            <option value="auto">자동{sheet && scale === 'auto' ? ` (${scaleLabel(sheet.scale)})` : ''}</option>
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
          <input type="checkbox" checked={dimensions} onChange={(e) => setDimensions(e.target.checked)} data-testid="drawing-dims" />
          자동 치수 (전체 크기·구멍 지름)
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
