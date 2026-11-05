import { describe, expect, it } from 'vitest';
import type { DrawingView } from '../engine/types';
import { cleanHidden } from './clean';
import { dxfText, sheetToDxf, sheetToSvg } from './exportSheet';
import { buildSheet, scaleLabel, type SheetOptions } from './sheet';
import { projectPoint } from './views';

const rectLine = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
/** 40×20×10 블록 + 윗면 지름 6 구멍 두 개 (엔진 투상 결과 모양) */
const VIEWS: DrawingView[] = [
  { name: 'front', visible: [rectLine(-20, 0, 20, 10)], hidden: [[-13, 10, -13, 5]], circles: [], bounds: [-20, 0, 20, 10] },
  {
    name: 'top',
    visible: [rectLine(-20, -10, 20, 10)],
    hidden: [],
    circles: [
      { center: [-10, 0], radius: 3, full: true, visible: true },
      { center: [10, 0], radius: 3, full: true, visible: true },
    ],
    bounds: [-20, -10, 20, 10],
  },
  { name: 'right', visible: [rectLine(-10, 0, 10, 10)], hidden: [], circles: [], bounds: [-10, 0, 10, 10] },
  { name: 'iso', visible: [[0, 0, 10, 10]], hidden: [], circles: [], bounds: [0, 0, 10, 10] },
];
const OPT: SheetOptions = { paper: 'A4', scale: 'auto', title: '받침 블록', date: '2026-11-05', dimensions: true };
const texts = (s: ReturnType<typeof buildSheet>) => s.items.flatMap((i) => (i.kind === 'text' ? [i.text] : []));

describe('도면 시트', () => {
  it('보기 방향: 정면 = −Y 쪽에서 (x 오른쪽, z 위), 우측면 = +X 쪽에서 (y 오른쪽)', () => {
    expect(projectPoint('front', [1, 2, 3])).toEqual([1, 3]);
    expect(projectPoint('top', [1, 2, 3])).toEqual([1, 2]);
    expect(projectPoint('right', [1, 2, 3])).toEqual([2, 3]);
  });

  it('자동 척도: 들어가는 가장 큰 표준 척도, 표제란에 표시', () => {
    const s = buildSheet(VIEWS, OPT);
    expect(s.scale).toBe(2);
    expect(s.overflow).toBe(false);
    expect(texts(s)).toEqual(expect.arrayContaining(['받침 블록', '2:1', '3각법', 'mm', '2026-11-05', '정면도', '평면도', '우측면도', '등각도']));
    const big = buildSheet(VIEWS.map((v) => ({ ...v, bounds: v.bounds.map((b) => b * 30) as DrawingView['bounds'] })), OPT);
    expect(scaleLabel(big.scale)).toBe('1:10');
    expect(buildSheet(VIEWS, { ...OPT, scale: 20 }).overflow).toBe(true);
  });

  it('3각법 배치: 평면도는 정면도 바로 위(가로 맞춤), 우측면도는 오른쪽(높이 맞춤)', () => {
    const s = buildSheet(VIEWS, { ...OPT, dimensions: false });
    const vis = s.items.flatMap((i) => (i.kind === 'line' && i.layer === 'visible' ? [i.points] : []));
    const box = (p: number[]) => {
      const xs = p.filter((_, k) => k % 2 === 0);
      const ys = p.filter((_, k) => k % 2 === 1);
      return [Math.min(...xs), Math.min(...ys), Math.max(...xs), Math.max(...ys)];
    };
    const [front, top, right] = vis.map(box);
    expect(top![0]).toBeCloseTo(front![0]!, 9);
    expect(top![1]).toBeGreaterThan(front![3]!);
    expect(right![1]).toBeCloseTo(front![1]!, 9);
    expect(right![3]).toBeCloseTo(front![3]!, 9);
    expect(right![0]).toBeGreaterThan(front![2]!);
    expect(front![2]! - front![0]!).toBeCloseTo(80, 9); // 40mm × 2:1
  });

  it('자동 치수: 너비·높이(정면), 깊이(우측면), 같은 지름 구멍은 2×Ø6', () => {
    const t = texts(buildSheet(VIEWS, OPT));
    expect(t).toEqual(expect.arrayContaining(['40', '10', '20', '2×Ø6']));
    expect(texts(buildSheet(VIEWS, { ...OPT, dimensions: false }))).not.toContain('40');
    // 우측면도가 없으면 깊이는 평면도에
    expect(texts(buildSheet(VIEWS.filter((v) => v.name !== 'right'), OPT))).toContain('20');
  });

  it('SVG: 용지 mm, y 뒤집기, 숨은선 파선, 글자 이스케이프', () => {
    const svg = sheetToSvg(buildSheet(VIEWS, { ...OPT, title: 'A<B' }));
    expect(svg).toContain('width="297mm" height="210mm" viewBox="0 0 297 210"');
    expect(svg).toContain('stroke-dasharray');
    expect(svg).toContain('A&lt;B');
    expect(svg).not.toMatch(/https?:\/\/(?!www\.w3\.org)/);
  });

  it('DXF: R12, 층·파선, 한글은 \\U+, 짝수 줄', () => {
    const dxf = sheetToDxf(buildSheet(VIEWS, OPT));
    expect(dxf).toContain('AC1009');
    expect(dxf).toMatch(/LAYER\r\n {2}2\r\nHIDDEN\r\n/);
    expect(dxf).toContain(dxfText('받침 블록'));
    expect(dxfText('Ø6 각')).toBe('\\U+00D86 \\U+AC01');
    const lines = dxf.split('\r\n').slice(0, -1);
    expect(lines.length % 2).toBe(0);
    expect(lines.at(-1)).toBe('EOF');
  });
});

describe('숨은선 정리 (서버 test_drawing.py 와 같은 규칙)', () => {
  it('보이는 선과 겹친 부분·같은 숨은선은 지우고, 꺾은선은 잇는다', () => {
    const visible = [[0, 0, 10, 0]];
    expect(cleanHidden(visible, [[5, 0, 15, 0], [5, 0, 15, 0]])).toEqual([[10, 0, 15, 0]]);
    expect(cleanHidden(visible, [[0, 1, 5, 1, 5, 6]])).toEqual([[0, 1, 5, 1, 5, 6]]);
    expect(cleanHidden(visible, [[-5, 0, 15, 0]])).toEqual([[-5, 0, 0, 0], [10, 0, 15, 0]]);
  });
});

describe('등각도', () => {
  it('숨은선을 그리지 않는다', () => {
    const iso: DrawingView = { name: 'iso', visible: [[0, 0, 10, 10]], hidden: [[0, 5, 10, 5]], circles: [], bounds: [0, 0, 10, 10] };
    const s = buildSheet([iso], OPT);
    expect(s.items.some((i) => i.layer === 'hidden')).toBe(false);
  });
});
