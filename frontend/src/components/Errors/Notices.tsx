/**
 * 알림 상자: 오류 제목 + 무엇을 하면 되는지 + 바로 누를 수 있는 동작 (실행 취소·파일로 저장·다시 불러오기 …).
 * 같은 오류는 "×3" 처럼 합친다. 마우스를 올리면 자동 닫힘을 멈춘다.
 */
import { useEffect, useState } from 'react';
import { useSceneStore, selectCanUndo } from '../../cad/sceneStore';
import { saveProject } from '../../features/projects/projectActions';
import { useNoticeStore, type Notice } from '../../features/errors/noticeStore';
import type { GuideAction } from '../../features/errors/errorGuide';

const ACTION_LABEL: Record<GuideAction, string> = {
  undo: '방금 변경 취소 (Ctrl+Z)',
  'select-sketch-constraints': '구속 목록 보기',
  'save-file': '파일로 저장',
  reload: '다시 불러오기',
  'restore-draft': '자동 저장본 열기',
};

export function Notices() {
  const notices = useNoticeStore((s) => s.notices);
  // 명령 거부(lastError) → 안내 상자 (상태 막대의 짧은 표시와 함께)
  useEffect(
    () =>
      useSceneStore.subscribe((s, prev) => {
        if (s.lastError && s.errorSeq !== prev.errorSeq) useNoticeStore.getState().report(s.lastError);
      }),
    [],
  );
  if (!notices.length) return null;
  return (
    <div className="notices" aria-live="polite">
      {notices.map((n) => (
        <NoticeCard key={n.id} n={n} />
      ))}
    </div>
  );
}

function NoticeCard({ n }: { n: Notice }) {
  const dismiss = useNoticeStore((s) => s.dismiss);
  const canUndo = useSceneStore(selectCanUndo);
  const [hover, setHover] = useState(false);
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (hover || open) return;
    const t = setTimeout(() => dismiss(n.id), n.level === 'error' ? 10_000 : 7_000);
    return () => clearTimeout(t);
  }, [hover, open, n.id, n.at, n.level, dismiss]);
  const run = (a: GuideAction) => {
    if (a === 'undo') useSceneStore.getState().undo();
    else if (a === 'save-file') void saveProject();
    else if (a === 'reload') window.location.reload();
    else if (a === 'select-sketch-constraints') document.querySelector<HTMLElement>('[data-testid="constraint-list"], .constraint-list')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    dismiss(n.id);
  };
  const actions = n.actions.filter((a) => a !== 'undo' || canUndo);
  return (
    <div className={`notice-card ${n.level}`} role="status" data-testid="notice-card" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="notice-head">
        <span className="notice-icon">{n.level === 'error' ? '⚠' : n.level === 'warn' ? '!' : 'i'}</span>
        <strong data-testid="notice-title">{n.title}</strong>
        {n.count > 1 && <span className="notice-count">×{n.count}</span>}
        <button className="notice-close" onClick={() => dismiss(n.id)} aria-label="닫기" title="닫기">
          ×
        </button>
      </div>
      {n.hint && (
        <p className="notice-hint" data-testid="notice-hint">
          {n.hint}
        </p>
      )}
      {(actions.length > 0 || n.raw !== n.title) && (
        <div className="notice-actions">
          {actions.map((a) => (
            <button key={a} onClick={() => run(a)} data-testid={`notice-${a}`}>
              {ACTION_LABEL[a]}
            </button>
          ))}
          {n.raw !== n.title && (
            <button className="link" onClick={() => setOpen(!open)}>
              {open ? '원문 닫기' : '원문 보기'}
            </button>
          )}
        </div>
      )}
      {open && <pre className="notice-raw">{n.raw}</pre>}
    </div>
  );
}
