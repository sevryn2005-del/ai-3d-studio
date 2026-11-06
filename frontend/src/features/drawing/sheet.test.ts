import { describe, expect, it } from 'vitest';
import type { DrawingView } from '../engine/types';
import { cleanHidden } from './clean';
import { dxfText, sheetToDxf, sheetToSvg } from './exportSheet';
import { buildSheet, clipToCircle, hatch, scaleLabel, tolText, type SheetOptions } from './sheet';
import { projectPoint } from './views';

const rectLine = (x0: number, y0: number, x1: number, y1: number) => [x0, y0, x1, y0, x1, y1, x0, y1, x0, y0];
/** 40×20×10 블록 + 윗면 지름 6 구멍 두 개 (엔진 투상 결과 모양) */
const VIEWS: DrawingView[] = [
  { name: 'front', visible: [rectLine(-20, 0, 20, 10)], hidden: [[-13, 10, -13, 5]], circles: [], axes: [], bounds: [-20, 0, 20, 10] },
  {
    name: 'top',
    visible: [rectLine(-20, -10, 20, 10)],
    hidden: [],
    circles: [
      { center: [-10, 0], radius: 3, full: true, visible: true },
      { center: [10, 0], radius: 3, full: true, visible: true },
    ],
    axes: [],
    bounds: [-20, -10, 20, 10],
  },
  { name: 'right', visible: [rectLine(-10, 0, 10, 10)], hidden: [], circles: [], axes: [], bounds: [-10, 0, 10, 10] },
  { name: 'iso', visible: [[0, 0, 10, 10]], hidden: [], circles: [], axes: [], bounds: [0, 0, 10, 10] },
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
    const iso: DrawingView = { name: 'iso', visible: [[0, 0, 10, 10]], hidden: [[0, 5, 10, 5]], circles: [], axes: [], bounds: [0, 0, 10, 10] };
    const s = buildSheet([iso], OPT);
    expect(s.items.some((i) => i.layer === 'hidden')).toBe(false);
  });
});

describe('도면 2단계: 해칭·절단선·중심선·주기', () => {
  it('해칭: 짝수-홀수 규칙 (구멍은 비움), 선 길이 합 ≈ 넓이 / 간격', () => {
    const outer = rectLine(0, 0, 20, 20);
    const hole = rectLine(5, 5, 15, 15);
    const lines = hatch([outer, hole], 1);
    const total = lines.reduce((s, l) => s + Math.hypot(l[2]! - l[0]!, l[3]! - l[1]!), 0);
    expect(total).toBeCloseTo((400 - 100) / 1, -1);
    // 구멍 가운데 (10, 10) 을 지나는 해칭은 없다
    const crosses = lines.some(([ax, ay, bx, by]) => {
      const t = ((10 - ax!) * (bx! - ax!) + (10 - ay!) * (by! - ay!)) / ((bx! - ax!) ** 2 + (by! - ay!) ** 2);
      return t > 0 && t < 1 && Math.hypot(ax! + (bx! - ax!) * t - 10, ay! + (by! - ay!) * t - 10) < 0.3;
    });
    expect(crosses).toBe(false);
    expect(hatch([])).toEqual([]);
  });

  const SECTIONED: DrawingView[] = VIEWS.map((v) => (v.name === 'front' ? { ...v, hidden: [], section: [rectLine(-20, 0, 20, 10)] } : v));
  const OPT2 = { ...OPT, section: { view: 'front' as const, offset: 0 } };

  it('정면 단면: 해칭·"단면 A-A", 평면도에 절단선과 A 두 개', () => {
    const s = buildSheet(SECTIONED, OPT2);
    expect(s.items.filter((i) => i.layer === 'hatch').length).toBeGreaterThan(5);
    const t = texts(s);
    expect(t).toContain('단면 A-A');
    expect(t).not.toContain('정면도');
    expect(t.filter((x) => x === 'A')).toHaveLength(2);
    // 단면 설정이 없으면 해칭·절단선 없음
    const plain = buildSheet(SECTIONED, OPT);
    expect(plain.items.some((i) => i.layer === 'hatch')).toBe(false);
    expect(texts(plain)).not.toContain('A');
  });

  it('우측면 단면: 정면도에 세로 절단선', () => {
    const views = VIEWS.map((v) => (v.name === 'right' ? { ...v, section: [rectLine(-10, 0, 10, 10)] } : v));
    const s = buildSheet(views, { ...OPT, section: { view: 'right', offset: 5 } });
    const center = s.items.filter((i) => i.kind === 'line' && i.layer === 'center') as { points: number[] }[];
    expect(center.some((c) => Math.abs(c.points[0]! - c.points[2]!) < 1e-9)).toBe(true);
    expect(texts(s)).toContain('단면 A-A');
  });

  it('중심선: 원마다 + 표시 2개, 축선은 2mm 넘김, 끄면 없음', () => {
    const views = VIEWS.map((v) => (v.name === 'front' ? { ...v, axes: [[0, 0, 0, 10]] } : v));
    const s = buildSheet(views, { ...OPT, centerlines: true });
    const center = s.items.filter((i) => i.kind === 'line' && i.layer === 'center') as { points: number[] }[];
    expect(center).toHaveLength(2 * 2 + 1);
    const axis = center.find((c) => Math.abs(c.points[0]! - c.points[2]!) < 1e-9 && Math.abs(c.points[3]! - c.points[1]! - (10 * s.scale + 4)) < 1e-9);
    expect(axis).toBeTruthy();
    expect(buildSheet(views, { ...OPT, centerlines: false }).items.some((i) => i.layer === 'center')).toBe(false);
  });

  it('주기: 빈 줄은 빼고 최대 6줄', () => {
    const t = texts(buildSheet(VIEWS, { ...OPT, notes: '지시 없는 모따기 C0.5\n\n재질 SS400\n3\n4\n5\n6\n7' }));
    expect(t).toEqual(expect.arrayContaining(['주기', '지시 없는 모따기 C0.5', '재질 SS400', '6']));
    expect(t).not.toContain('7');
    expect(texts(buildSheet(VIEWS, OPT))).not.toContain('주기');
  });

  it('DXF: CENTER 선 종류·HATCH 층', () => {
    const dxf = sheetToDxf(buildSheet(SECTIONED, { ...OPT2, centerlines: true }));
    expect(dxf).toMatch(/LTYPE\r\n {2}2\r\nCENTER\r\n/);
    expect(dxf).toContain('HATCH');
    expect(sheetToSvg(buildSheet(SECTIONED, OPT2))).toContain('class="hatch"');
  });

  it('공차 글자: ±, +위/−아래, 0 은 그대로', () => {
    expect(tolText(undefined)).toBe('');
    expect(tolText({ upper: 0.1, lower: -0.1 })).toBe(' ±0.1');
    expect(tolText({ upper: 0.1, lower: -0.05 })).toBe(' +0.1/−0.05');
    expect(tolText({ upper: 0, lower: -0.02 })).toBe(' 0/−0.02');
    expect(tolText({ upper: 0, lower: 0 })).toBe('');
  });

  it('원으로 자르기: 원 밖은 버리고, 들어갔다 나온 선은 조각으로', () => {
    expect(clipToCircle([-10, 0, 10, 0], [0, 0], 5)).toEqual([[-5, 0, 5, 0]]);
    expect(clipToCircle([-10, 8, 10, 8], [0, 0], 5)).toEqual([]);
    const two = clipToCircle([-10, 0, 10, 0, 10, 10, -10, 10], [0, 5], 6); // ㄷ 모양: 아래·위 변만 원을 지나감
    expect(two).toHaveLength(2);
  });

  it('상세도: 원래 보기에 원 + 기호 B, 확대 그림은 보기·표제란과 겹치지 않는 자리 / 공차는 치수 글자 뒤에', () => {
    const s = buildSheet(VIEWS, {
      ...OPT,
      scale: 1,
      details: [{ id: 'det1', view: 'top', center: [-18, -8], radius: 5, scale: 3 }],
      dims: [{ id: 'd1', view: 'front', kind: 'horizontal', a: { at: [-20, 0], rel: [0, 0] }, b: { at: [20, 0], rel: [1, 0] }, offset: -10, tol: { upper: 0.1, lower: -0.1 } }],
    });
    expect(texts(s)).toEqual(expect.arrayContaining(['B', '상세 B (3:1)', '40 ±0.1']));
    expect(s.details).toHaveLength(1);
    const d = s.details[0]!;
    expect(d.radius).toBeCloseTo(15);
    expect(s.overflow).toBe(false);
    // 확대 그림 안의 보이는 선 = 원 안에만 (반지름 + 여유)
    const inDetail = s.items.filter((i) => i.kind === 'line' && i.layer === 'visible' && i.points.every((v, k) => (k % 2 ? true : Math.hypot(v - d.center[0], i.points[k + 1]! - d.center[1]) <= d.radius + 1e-6)));
    expect(inDetail.length).toBeGreaterThan(0);
    // 다른 보기 범위와 겹치지 않음
    for (const [name, pl] of Object.entries(s.placements)) {
      const w = (pl.bounds[2] - pl.bounds[0]) * pl.scale;
      const h = (pl.bounds[3] - pl.bounds[1]) * pl.scale;
      const nearX = Math.max(pl.at[0], Math.min(d.center[0], pl.at[0] + w));
      const nearY = Math.max(pl.at[1], Math.min(d.center[1], pl.at[1] + h));
      expect(Math.hypot(nearX - d.center[0], nearY - d.center[1]), name).toBeGreaterThan(d.radius);
    }
  });
});
