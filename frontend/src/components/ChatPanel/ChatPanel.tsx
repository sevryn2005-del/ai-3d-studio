import { useEffect, useRef, useState } from 'react';
import { appConfig } from '../../api/config';
import { useBackendStore } from '../../features/backend/backendStore';
import { useAiStore, type ChatMessage } from '../../features/ai/aiStore';
import { AiSettingsDialog } from './AiSettingsDialog';

/** USD 금액 표시: 작은 금액도 보이도록 */
export function formatUsd(v: number): string {
  if (v === 0) return '$0';
  if (v < 0.01) return `$${v.toFixed(4)}`;
  return `$${v.toFixed(2)}`;
}

type Availability =
  | { ready: true; label: string }
  | { ready: false; reason: string; action?: 'settings' };

function useAvailability(): Availability {
  const connection = useBackendStore((s) => s.connection);
  const settings = useAiStore((s) => s.settings);
  if (appConfig().cadEngine === 'browser') {
    return { ready: false, reason: 'AI 기능은 로컬 모드·Windows 앱에서 사용할 수 있습니다. 모델링은 그대로 할 수 있어요.' };
  }
  if (connection !== 'online') {
    return { ready: false, reason: '로컬 서버에 연결되면 AI 를 쓸 수 있습니다. 모델링은 그대로 할 수 있어요.' };
  }
  if (!settings) return { ready: false, reason: 'AI 설정을 불러오는 중…' };
  if (!settings.enabled) return { ready: false, reason: 'AI 기능이 꺼져 있습니다.', action: 'settings' };
  if (!settings.keyConfigured) {
    return { ready: false, reason: 'AI 를 쓰려면 Anthropic API 키가 필요합니다. 키는 이 PC 에만 저장됩니다.', action: 'settings' };
  }
  return { ready: true, label: settings.models.find((m) => m.id === settings.model)?.label.replace(/ \(.*\)$/, '') ?? settings.model };
}

export function ChatPanel() {
  const messages = useAiStore((s) => s.messages);
  const pending = useAiStore((s) => s.pending);
  const month = useAiStore((s) => s.month);
  const { send, cancel, setSettingsOpen, loadSettings } = useAiStore.getState();
  const connection = useBackendStore((s) => s.connection);
  const availability = useAvailability();
  const [input, setInput] = useState('');
  const listRef = useRef<HTMLDivElement>(null);

  // 로컬 서버 설정·사용량 읽기 (AI API 호출 아님, 비용 없음)
  useEffect(() => {
    if (connection === 'online' && appConfig().cadEngine !== 'browser') void loadSettings();
  }, [connection, loadSettings]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight });
  }, [messages, pending]);

  const submit = (text = input) => {
    if (!availability.ready || pending || !text.trim()) return;
    if (text === input) setInput('');
    void send(text);
  };

  return (
    <aside className="panel chat" aria-label="AI 대화">
      <header className="panel-header">
        AI 설계 도우미
        <span className={`badge ${availability.ready ? 'on' : ''}`} data-testid="ai-status">
          {availability.ready ? availability.label : '사용 안 함'}
        </span>
        <span className="spacer" />
        {month && month.requests > 0 && (
          <button className="link" onClick={() => setSettingsOpen(true)} title="AI 사용량 보기" data-testid="ai-month-cost">
            이번 달 {formatUsd(month.costUsd)}
          </button>
        )}
        {appConfig().cadEngine !== 'browser' && (
          <button className="icon" onClick={() => setSettingsOpen(true)} aria-label="AI 설정" title="AI 설정 · 사용량">
            ⚙
          </button>
        )}
      </header>

      <div className="messages" ref={listRef} aria-live="polite">
        {messages.map((m) => (
          <MessageBubble key={m.id} m={m} onOption={(o) => submit(o)} disabled={!!pending || !availability.ready} />
        ))}
        {pending && (
          <div className="msg assistant thinking" data-testid="ai-pending">
            설계를 고민하는 중… <button className="link" onClick={cancel}>취소</button>
          </div>
        )}
      </div>

      {!availability.ready && (
        <div className="chat-notice" data-testid="ai-unavailable">
          <span>{availability.reason}</span>
          {availability.action === 'settings' && <button onClick={() => setSettingsOpen(true)}>AI 설정</button>}
        </div>
      )}

      <form
        className="composer"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        <textarea
          value={input}
          placeholder="예: 높이를 50mm로 바꿔줘"
          rows={3}
          aria-label="AI 에게 보낼 메시지"
          data-model-undo="when-empty"
          disabled={!availability.ready}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              submit();
            }
          }}
        />
        <button type="submit" disabled={!availability.ready || !!pending || !input.trim()}>
          전송
        </button>
      </form>
      <AiSettingsDialog />
    </aside>
  );
}

function MessageBubble({ m, onOption, disabled }: { m: ChatMessage; onOption: (o: string) => void; disabled: boolean }) {
  return (
    <div className={`msg ${m.role} ${m.kind ?? ''}`} data-kind={m.kind}>
      <div className="msg-text">{m.text}</div>
      {m.changes && m.changes.length > 0 && (
        <ul className="changes" aria-label="적용한 변경">
          {m.changes.map((c, i) => (
            <li key={i}>{c}</li>
          ))}
        </ul>
      )}
      {m.kind === 'commands' && <div className="muted small">Ctrl+Z 한 번으로 되돌릴 수 있습니다</div>}
      {m.options && m.options.length > 0 && (
        <div className="options">
          {m.options.map((o) => (
            <button key={o} disabled={disabled} onClick={() => onOption(o)}>
              {o}
            </button>
          ))}
        </div>
      )}
      {m.costUsd !== undefined && <div className="cost muted small">예상 비용 {formatUsd(m.costUsd)}</div>}
    </div>
  );
}
