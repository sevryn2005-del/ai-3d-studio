import { useEffect, useId, useState } from 'react';
import { formatMm } from '../../cad/units';

interface Props {
  label: string;
  value: number;
  unit: 'mm' | '°';
  onCommit: (value: number) => void;
  testId?: string;
}

/**
 * 숫자 입력 필드. 입력 중에는 로컬 초안만 바뀌고,
 * Enter 또는 포커스 해제 시에만 명령을 발행한다 (키 입력마다 히스토리가 쌓이지 않도록).
 * Esc 는 원래 값으로 되돌린다. 실패 시 스토어 값으로 자동 복원된다.
 */
export function NumberField({ label, value, unit, onCommit, testId }: Props) {
  const id = useId();
  const [draft, setDraft] = useState(formatMm(value));

  useEffect(() => setDraft(formatMm(value)), [value]);

  const commit = () => {
    const n = Number(draft.trim().replace(',', '.'));
    if (draft.trim() === '' || !Number.isFinite(n)) {
      setDraft(formatMm(value));
      return;
    }
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
    </div>
  );
}
