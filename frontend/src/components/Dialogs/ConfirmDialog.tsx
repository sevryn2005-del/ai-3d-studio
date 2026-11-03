import { useEffect, useRef } from 'react';
import { useConfirmStore } from '../../features/dialogs/confirmStore';

export function ConfirmDialog() {
  const request = useConfirmStore((s) => s.request);
  const answer = useConfirmStore((s) => s.answer);
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (!request) return;
    confirmRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        answer(false);
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [request, answer]);

  if (!request) return null;
  return (
    <div className="dialog-backdrop" onMouseDown={() => answer(false)}>
      <div
        className="dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-message"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <p id="confirm-message">{request.message}</p>
        <div className="row">
          <button onClick={() => answer(false)}>취소</button>
          <button ref={confirmRef} className="danger" onClick={() => answer(true)}>
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
