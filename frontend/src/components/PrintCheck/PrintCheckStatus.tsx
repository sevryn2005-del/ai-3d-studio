import { useEffect, useRef, useState } from 'react';
import { useSceneStore } from '../../cad/sceneStore';
import { usePrintCheck } from '../../features/print/usePrintCheck';

/** 하단 상태바의 출력 전 검사 결과 + 문제 목록 */
export function PrintCheckStatus() {
  const { issues, exact } = usePrintCheck();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const errors = issues.filter((i) => i.severity === 'error').length;
  const warnings = issues.length - errors;

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

  const label =
    issues.length === 0
      ? '출력 검사 ✓'
      : `출력 검사: ${[errors && `오류 ${errors}`, warnings && `경고 ${warnings}`].filter(Boolean).join(' · ')}`;

  return (
    <div className="print-check" ref={ref}>
      <button
        className={`print-check-button ${errors ? 'has-error' : warnings ? 'has-warning' : 'ok'}`}
        data-testid="print-check"
        aria-expanded={open}
        title={exact ? '출력 전 형상 검사' : '일부 객체는 형상 계산 전이라 근사로 검사했습니다'}
        onClick={() => setOpen((o) => !o)}
      >
        {label}
      </button>
      {open && <PrintCheckPanel onClose={() => setOpen(false)} />}
    </div>
  );
}

function PrintCheckPanel({ onClose }: { onClose: () => void }) {
  const { issues } = usePrintCheck();
  const { dispatch, select } = useSceneStore.getState();
  return (
    <div className="print-check-panel" role="dialog" aria-label="출력 전 검사">
      <header>
        <strong>출력 전 검사</strong>
        <button className="link" onClick={onClose}>닫기</button>
      </header>
      {issues.length === 0 ? (
        <p className="muted">문제가 없습니다. 바닥에 놓여 있고, 출력 범위 안이며, 너무 얇은 부분이 없습니다.</p>
      ) : (
        <ul>
          {issues.map((i) => (
            <li key={i.key} className={i.severity}>
              <span className="sev">{i.severity === 'error' ? '오류' : '경고'}</span>
              <span className="msg">{i.message}</span>
              <span className="actions">
                <button className="link" onClick={() => select(i.objectId)}>선택</button>
                {i.fix && <button onClick={() => dispatch(i.fix!.command)}>{i.fix.label}</button>}
              </span>
            </li>
          ))}
        </ul>
      )}
      <p className="muted small">기준: 출력 범위 220×220×250mm, 최소 두께 0.8mm (0.4mm 노즐 기준)</p>
    </div>
  );
}
