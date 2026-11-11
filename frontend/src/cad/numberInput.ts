/**
 * 숫자 입력 너그럽게 읽기 (사람이 실제로 치는 대로): 전각 숫자·쉼표·단위·간단한 계산식.
 * - "1,000" → 1000, "2,5" → 2.5 (쉼표 뒤 3자리면 천 단위, 아니면 소수점)
 * - 단위: mm·cm·m·in·inch·"·ft·′ → mm, °·deg·도·rad (각도 칸) — 칸 단위와 다르면 바꿔서
 * - 계산: + − × ÷ * / ^ 괄호, 분수 "1/2" (eval 없이 직접 해석)
 * 읽을 수 없으면 { ok: false, error } — 이유를 사람이 알아듣게.
 */

export type FieldUnit = 'mm' | '°' | '×' | '개';
export type ParseResult = { ok: true; value: number; note?: string } | { ok: false; error: string };

const LENGTH: Record<string, number> = { mm: 1, cm: 10, m: 1000, in: 25.4, inch: 25.4, '"': 25.4, '″': 25.4, ft: 304.8, "'": 304.8, '′': 304.8 };
const ANGLE: Record<string, number> = { '°': 1, deg: 1, 도: 1, rad: 180 / Math.PI };

function normalize(text: string): string {
  return text
    .trim()
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[．。]/g, '.')
    .replace(/[，]/g, ',')
    .replace(/[×xX＊]/g, '*')
    .replace(/[÷／]/g, '/')
    .replace(/[−–—ー]/g, '-')
    .replace(/[＋]/g, '+')
    .replace(/[（]/g, '(')
    .replace(/[）]/g, ')')
    .replace(/\s+/g, '');
}

/** 쉼표: 천 단위(1,000 · 12,345.6) 또는 소수점(2,5) */
function commas(s: string): string {
  return s.replace(/\d+(?:,\d+)+(?:\.\d+)?/g, (m) => (/^\d{1,3}(,\d{3})+(\.\d+)?$/.test(m) ? m.replace(/,/g, '') : m.replace(',', '.')));
}

/** 재귀 하강 계산기: expr = term (('+'|'-') term)*, term = factor (('*'|'/') factor)*, factor = unary ('^' factor)? */
function evaluate(src: string): number | null {
  let i = 0;
  const peek = () => src[i];
  const num = (): number | null => {
    const m = /^\d*\.?\d+(?:e[+-]?\d+)?/i.exec(src.slice(i));
    if (!m) return null;
    i += m[0].length;
    return Number(m[0]);
  };
  const factor = (): number | null => {
    let sign = 1;
    while (peek() === '-' || peek() === '+') sign *= src[i++] === '-' ? -1 : 1;
    let v: number | null;
    if (peek() === '(') {
      i++;
      v = expr();
      if (peek() !== ')') return null;
      i++;
    } else v = num();
    if (v === null) return null;
    if (peek() === '^') {
      i++;
      const e = factor();
      if (e === null) return null;
      v = v ** e;
    }
    return sign * v;
  };
  const term = (): number | null => {
    let v = factor();
    while (v !== null && (peek() === '*' || peek() === '/')) {
      const op = src[i++];
      const r = factor();
      if (r === null) return null;
      v = op === '*' ? v * r : v / r;
    }
    return v;
  };
  const expr = (): number | null => {
    let v = term();
    while (v !== null && (peek() === '+' || peek() === '-')) {
      const op = src[i++];
      const r = term();
      if (r === null) return null;
      v = op === '+' ? v + r : v - r;
    }
    return v;
  };
  const v = expr();
  return v !== null && i === src.length ? v : null;
}

export function parseNumberInput(text: string, unit: FieldUnit = 'mm'): ParseResult {
  let s = commas(normalize(text));
  if (!s) return { ok: false, error: '값이 비어 있습니다' };
  let scale = 1;
  let note: string | undefined;
  const table = unit === '°' ? ANGLE : unit === 'mm' ? LENGTH : {};
  const keys = Object.keys(table).sort((a, b) => b.length - a.length);
  const suffix = keys.find((k) => s.toLowerCase().endsWith(k.toLowerCase()));
  if (suffix) {
    s = s.slice(0, -suffix.length);
    scale = table[suffix]!;
    if (scale !== 1) note = `${suffix} → ${unit}`;
  } else if (/[a-z가-힣]+$/i.test(s)) {
    const u = /[a-z가-힣]+$/i.exec(s)![0];
    return { ok: false, error: unit === '°' ? `각도 칸입니다 — '${u}' 대신 숫자(°)를 넣으세요` : unit === 'mm' ? `'${u}' 단위는 모릅니다 (mm·cm·m·in 을 쓸 수 있습니다)` : `숫자만 넣으세요 ('${u}' 는 읽을 수 없습니다)` };
  }
  const v = evaluate(s);
  if (v === null) return { ok: false, error: `숫자로 읽을 수 없습니다: "${text.trim()}"` };
  if (!Number.isFinite(v)) return { ok: false, error: '0 으로 나눌 수 없습니다' };
  const value = Math.round(v * scale * 1e6) / 1e6;
  if (unit === '개' && !Number.isInteger(value)) return { ok: false, error: '개수는 정수여야 합니다' };
  if (/[+\-*/^()]/.test(s.replace(/^-/, '')) && !note) note = `= ${value}`;
  return { ok: true, value, note };
}
