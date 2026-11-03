import { useEffect, useRef, useState } from 'react';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { getActiveEngine, useActiveEngineId } from '../../features/engine/engines';
import { downloadExport, EXPORT_FORMATS } from '../../features/projects/exportModel';
import { currentPrintCheck } from '../../features/print/usePrintCheck';
import { confirmDialog } from '../../features/dialogs/confirmStore';

/** 내보내기 형식 선택 메뉴. 활성 CAD 엔진(서버 또는 브라우저)이 파일을 만든다. */
export function ExportMenu() {
  const engineId = useActiveEngineId();
  const engine = engineId ? getActiveEngine(engineId) : null;
  const hasObjects = useSceneStore((s) => selectModel(s).objects.length > 0);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent | KeyboardEvent) => {
      if (e instanceof KeyboardEvent) {
        if (e.key !== 'Escape') return;
        e.preventDefault(); // 전역 Esc(선택 해제)가 함께 동작하지 않도록
        setOpen(false);
      } else if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', close);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', close);
    };
  }, [open]);

  const disabled = !engine || !hasObjects || busy !== null;
  return (
    <div className="menu" ref={ref}>
      <button
        disabled={disabled}
        aria-haspopup="menu"
        aria-expanded={open}
        title={!engine ? 'CAD 엔진을 사용할 수 없습니다' : `파일로 내보내기 (${engine.label})`}
        onClick={() => setOpen((o) => !o)}
      >
        {busy ? `${busy} 내보내는 중…` : '내보내기 ▾'}
      </button>
      {open && (
        <ul className="menu-list" role="menu" aria-label="내보내기 형식">
          {EXPORT_FORMATS.map((f) => {
            const supported = !!engine?.exportFormats.includes(f.format);
            return (
              <li key={f.format} role="none">
                <button
                  role="menuitem"
                  disabled={!supported}
                  title={supported ? undefined : `${engine?.label} 에서는 지원하지 않습니다 (로컬 CAD 서버 필요)`}
                  onClick={async () => {
                    if (!engineId) return;
                    setOpen(false);
                    // 출력 불가 문제(오류)가 있으면 한 번 확인한다. 경고는 막지 않는다.
                    const errors = currentPrintCheck().issues.filter((i) => i.severity === 'error');
                    if (errors.length > 0) {
                      const go = await confirmDialog(
                        `출력 전 검사에서 오류 ${errors.length}건이 있습니다: ${errors[0]!.message}. 그래도 내보낼까요?`,
                        '그래도 내보내기',
                      );
                      if (!go) return;
                    }
                    setBusy(f.label);
                    await downloadExport(engineId, f.format);
                    setBusy(null);
                  }}
                >
                  <strong>{f.label}</strong>
                  <span className="muted">{supported ? f.hint : '로컬 CAD 서버 필요'}</span>
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
