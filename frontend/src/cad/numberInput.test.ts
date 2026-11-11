import { describe, expect, it } from 'vitest';
import { parseNumberInput } from './numberInput';

const v = (t: string, u?: Parameters<typeof parseNumberInput>[1]) => {
  const r = parseNumberInput(t, u);
  return r.ok ? r.value : r.error;
};

describe('숫자 입력 너그럽게 읽기', () => {
  it('보통 숫자·전각·쉼표', () => {
    expect(v('12.5')).toBe(12.5);
    expect(v(' ２０ ')).toBe(20);
    expect(v('1,000')).toBe(1000);
    expect(v('2,5')).toBe(2.5);
    expect(v('-3')).toBe(-3);
  });
  it('단위 바꾸기', () => {
    expect(v('5cm')).toBe(50);
    expect(v('0.2 m')).toBe(200);
    expect(v('1in')).toBe(25.4);
    expect(v('2"')).toBe(50.8);
    expect(v('90°', '°')).toBe(90);
    expect(v('45도', '°')).toBe(45);
    expect(v(String(Math.PI / 2) + 'rad', '°')).toBe(90);
  });
  it('계산식', () => {
    expect(v('20*2+5')).toBe(45);
    expect(v('100/3')).toBeCloseTo(33.333333, 5);
    expect(v('(10+5)×2')).toBe(30);
    expect(v('1/2')).toBe(0.5);
    expect(v('2^3')).toBe(8);
    expect(v('10 cm + 5')).toBe('숫자로 읽을 수 없습니다: "10 cm + 5"'); // 단위는 끝에만
  });
  it('읽을 수 없으면 이유', () => {
    expect(v('')).toBe('값이 비어 있습니다');
    expect(v('abc')).toMatch(/단위는 모릅니다/);
    expect(v('5/0')).toBe('0 으로 나눌 수 없습니다');
    expect(v('2.5', '개')).toBe('개수는 정수여야 합니다');
    expect(v('3kg')).toMatch(/kg/);
    expect(v('((2')).toMatch(/읽을 수 없습니다/);
  });
});
