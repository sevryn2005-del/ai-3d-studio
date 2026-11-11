import { useEffect, useId, useState } from 'react';
import { formatMm } from '../../cad/units';
import { parseNumberInput } from '../../cad/numberInput';

interface Props {
  label: string;
  value: number;
  unit: 'mm' | '°' | '×' | '개';
  onCommit: (value: number) => void;
  testId?: string;
}

/**
 * 숫자 입력 필드. 입력 중에는 로컬 초안만 바뀌고,
 * Enter 또는 포커스 해제 시에만 명령을 발행한다 (키 입력마다 히스토리가 쌓이지 않도록).
 * Esc 는 원래 값으로 되돌린다. 실패 시 스토어 값으로 자동 복원된다.
 * 사람이 치는 대로 읽는다 (cad/numberInput.ts): "5cm" → 50, "20*2+5" → 45, 전각 숫자·"1,000".
 * 읽을 수 없으면 원래 값으로 되돌리고 칸 아래에 이유를 잠깐 보여 준다 (말없이 무시하지 않음).
 */
export function NumberField({ label, value, unit, onCommit, testId }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(formatMm(value));
  const [message, setMessage] = useState<{ text: string; bad: boolean } | null>(null);

  useEffect(() => setDraft(formatMm(value)), [value]);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), message.bad ? 4000 : 2500);
    return () => clearTimeout(t);
  }, [message]);

  const commit = () => {
    if (draft.trim() === formatMm(value)) return;
    const r = parseNumberInput(draft, unit);
    if (!r.ok) {
      setDraft(formatMm(value));
      if (draft.trim() !== '') setMessage({ text: `${r.error} — 원래 값(${formatMm(value)})으로 두었습니다`, bad: true });
      return;
    }
    const n = r.value;
    if (r.note) setMessage({ text: `${draft.trim()} ${r.note.startsWith('=') ? r.note : `(${r.note})`} → ${formatMm(n)}`, bad: false });
    if (n !== value) onCommit(n);
    // 명령이 거부되면 value 가 그대로이므로 초안을 되돌린다.
    setDraft(formatMm(value));
  };

  return (
    <div className="field">
      <label htmlFor={id}>{label}</label>
      <div className="field-input">
        <input
          id={id}
          data-testid={testId}
          inputMode="decimal"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === 'Enter') (e.target as HTMLInputElement).blur();
            if (e.key === 'Escape') {
              setDraft(formatMm(value));
              (e.target as HTMLInputElement).blur();
            }
          }}
        />
        <span className="unit">{unit}</span>
      </div>
      {message && (
        <div className={`field-message${message.bad ? ' bad' : ''}`} data-testid={testId ? `${testId}-message` : undefined}>
          {message.text}
        </div>
      )}
    </div>
  );
}
