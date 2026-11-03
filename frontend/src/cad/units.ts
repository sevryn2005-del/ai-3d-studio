/** 화면 표시용 숫자 포맷. 내부 값은 항상 mm 그대로 유지한다. */
export function formatMm(v: number): string {
  return Number.isInteger(v) ? String(v) : v.toFixed(2).replace(/\.?0+$/, '');
}

export const DEG2RAD = Math.PI / 180;
