import { useEffect, useState } from 'react';
import { getAiUsage, updateAiSettings, type Price, type UsageSummary } from '../../api/ai';
import { useAiStore } from '../../features/ai/aiStore';
import { formatUsd } from './ChatPanel';

/** AI 설정(사용자 API 키, 모델, 가격표)과 사용량·예상 비용 */
export function AiSettingsDialog() {
  const open = useAiStore((s) => s.settingsOpen);
  const settings = useAiStore((s) => s.settings);
  const { setSettingsOpen, setSettings } = useAiStore.getState();
  const [key, setKey] = useState('');
  const [usage, setUsage] = useState<UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setKey('');
    setError(null);
    setSaved(null);
    getAiUsage().then(setUsage).catch(() => setUsage(null));
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setSettingsOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, setSettingsOpen]);

  if (!open) return null;

  const save = async (patch: Record<string, unknown>, done: string) => {
    setError(null);
    try {
      const r = await updateAiSettings(patch);
      if (r.ok === false) throw new Error('저장하지 못했습니다');
      const { ok: _ok, ...view } = r;
      void _ok;
      setSettings(view as NonNullable<typeof settings>);
      setSaved(done);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  };

  const current = settings?.models.find((m) => m.id === settings.model);

  return (
    <div className="dialog-backdrop" onMouseDown={() => setSettingsOpen(false)}>
      <div className="dialog wide" role="dialog" aria-modal="true" aria-labelledby="ai-settings-title" onMouseDown={(e) => e.stopPropagation()}>
        <h2 id="ai-settings-title">AI 설정 · 사용량</h2>
        {!settings ? (
          <p className="muted">로컬 서버에 연결되면 설정할 수 있습니다.</p>
        ) : (
          <>
            <section>
              <h3>Anthropic API 키</h3>
              <p className="muted small">
                AI 요금은 본인 API 키로 Anthropic 에 직접 청구됩니다. 키는 이 PC 의 로컬 서버에만 저장되고 브라우저나 프로젝트 파일에는 남지 않습니다.
              </p>
              <div className="field-row">
                <input
                  type="password"
                  autoComplete="off"
                  aria-label="API 키"
                  placeholder={settings.keyConfigured ? `저장됨 ${settings.keyHint ?? ''}${settings.keySource === 'environment' ? ' (환경 변수)' : ''}` : 'sk-ant-…'}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button disabled={key.trim().length < 8} onClick={() => save({ apiKey: key.trim() }, 'API 키를 저장했습니다')}>
                  저장
                </button>
                {settings.keySource === 'saved' && (
                  <button className="danger" onClick={() => save({ clearKey: true }, 'API 키를 삭제했습니다')}>
                    삭제
                  </button>
                )}
              </div>
            </section>

            <section>
              <h3>모델</h3>
              <div className="field-row">
                <select aria-label="AI 모델" value={settings.model} onChange={(e) => save({ model: e.target.value }, '모델을 바꿨습니다')}>
                  {settings.models.map((m) => (
                    <option key={m.id} value={m.id}>
                      {m.label} — 입력 ${m.price.input} / 출력 ${m.price.output} (100만 토큰당)
                    </option>
                  ))}
                </select>
                <label className="check">
                  <input type="checkbox" checked={settings.enabled} onChange={(e) => save({ enabled: e.target.checked }, e.target.checked ? 'AI 를 켰습니다' : 'AI 를 껐습니다')} />
                  AI 사용
                </label>
              </div>
              {current && <PriceEditor price={current.price} onSave={(p) => save({ prices: { [current.id]: p } }, '가격표를 저장했습니다')} />}
            </section>

            <section>
              <h3>사용량 (예상 비용)</h3>
              {usage ? (
                <>
                  <table className="usage">
                    <thead>
                      <tr><th></th><th>요청</th><th>입력 토큰</th><th>출력 토큰</th><th>예상 비용</th></tr>
                    </thead>
                    <tbody>
                      {([['오늘', usage.today], ['이번 달', usage.month], ['전체', usage.all]] as const).map(([label, t]) => (
                        <tr key={label} data-testid={`usage-${label}`}>
                          <th>{label}</th>
                          <td>{t.requests}</td>
                          <td>{t.inputTokens.toLocaleString()}</td>
                          <td>{t.outputTokens.toLocaleString()}</td>
                          <td>{formatUsd(t.costUsd)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="muted small">
                    가격표로 계산한 추정치입니다. 실제 청구액은 Anthropic 콘솔에서 확인하세요. 기록은 이 PC 에만 저장됩니다.
                  </p>
                </>
              ) : (
                <p className="muted">사용 기록을 불러오지 못했습니다.</p>
              )}
            </section>
          </>
        )}
        {error && <p className="error" role="alert">{error}</p>}
        {saved && !error && <p className="ok-text" role="status">{saved}</p>}
        <div className="row end">
          <button onClick={() => setSettingsOpen(false)}>닫기</button>
        </div>
      </div>
    </div>
  );
}

function PriceEditor({ price, onSave }: { price: Price; onSave: (p: Price) => void }) {
  const [draft, setDraft] = useState(price);
  useEffect(() => setDraft(price), [price]);
  const fields: [keyof Price, string][] = [['input', '입력'], ['output', '출력'], ['cacheRead', '캐시 읽기'], ['cacheWrite', '캐시 쓰기']];
  const changed = fields.some(([k]) => draft[k] !== price[k]);
  return (
    <details className="price-editor">
      <summary className="muted small">가격표 수정 (USD / 100만 토큰)</summary>
      <div className="price-grid">
        {fields.map(([k, label]) => (
          <label key={k}>
            {label}
            <input
              type="number"
              min={0}
              step="0.01"
              value={draft[k]}
              onChange={(e) => setDraft({ ...draft, [k]: Math.max(0, Number(e.target.value) || 0) })}
            />
          </label>
        ))}
        <button disabled={!changed} onClick={() => onSave(draft)}>가격 저장</button>
      </div>
    </details>
  );
}
