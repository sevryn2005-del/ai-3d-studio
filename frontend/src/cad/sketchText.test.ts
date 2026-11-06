import { describe, expect, it } from 'vitest';
import opentype from 'opentype.js';
import { missingChars, signedArea, textContours, textSketchCommands, type GlyphSource } from './sketchText';
import { CadCommandSchema, LIMITS } from './commandTypes';
import fontData from '../assets/fonts/NotoSansKR-Bold-subset.ttf?inline';

const bin = atob(fontData.slice(fontData.indexOf(',') + 1));
const font = opentype.parse(Uint8Array.from(bin, (c) => c.charCodeAt(0)).buffer);
const src: GlyphSource = { getPath: (t, x, y, s) => font.getPath(t, x, y, s), hasChar: (ch) => font.charToGlyphIndex(ch) > 0 };

const bounds = (cs: [number, number][][]) => {
  const xs = cs.flat().map((p) => p[0]);
  const ys = cs.flat().map((p) => p[1]);
  return { x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys) };
};

describe('스케치 텍스트', () => {
  it("'O' = 바깥 + 구멍 (합치기, 빼기), 'A' = 겹친 두 획 (합치기 둘), 가운데 맞춤", () => {
    const a = textContours(src, { text: 'A', size: 10, center: [0, 0] });
    expect((textSketchCommands(a, 'sk', new Set()).commands.at(-1) as { items: { op: string }[] }).items.map((i) => i.op)).toEqual(['add', 'add']);
    const cs = textContours(src, { text: 'O', size: 10, center: [5, 5] });
    expect(cs).toHaveLength(2);
    const b = bounds(cs);
    expect((b.x0 + b.x1) / 2).toBeCloseTo(5, 3);
    expect((b.y0 + b.y1) / 2).toBeCloseTo(5, 3);
    expect(b.y1 - b.y0).toBeGreaterThan(6); // 대문자 높이 ≈ 0.75 em
    expect(b.y1 - b.y0).toBeLessThan(8.5);
    const r = textSketchCommands(cs, 'sk', new Set());
    const region = r.commands.find((c) => c.type === 'add_region') as { items: { op: string }[] };
    expect(region.items.map((i) => i.op)).toEqual(['add', 'subtract']);
    for (const c of r.commands) {
      expect(CadCommandSchema.safeParse(c).success).toBe(true);
      if (c.type === 'add_polygon') expect(signedArea(c.points)).toBeGreaterThan(0); // 반시계
    }
  });

  it("한글 '안녕' — 'ㅇ' 속은 빠지고 모든 윤곽이 점 64개 이하", () => {
    const cs = textContours(src, { text: '안녕', size: 20, center: [0, 0] });
    expect(cs.length).toBeGreaterThanOrEqual(6);
    for (const pts of cs) expect(pts.length).toBeLessThanOrEqual(LIMITS.maxPolygonPoints);
    const r = textSketchCommands(cs, 'sk', new Set(['text1']));
    expect(r.commands[0]).toMatchObject({ type: 'add_polygon', id: 'text2' });
    const ops = (r.commands.at(-1) as { items: { op: string }[] }).items.map((i) => i.op);
    expect(ops.filter((o) => o === 'subtract').length).toBeGreaterThanOrEqual(2); // ㅇ 두 개의 속
    expect(ops[0]).toBe('add');
    const b = bounds(cs);
    expect(b.x1 - b.x0).toBeGreaterThan(30); // 두 글자 ≈ 2 em 가까이
  });

  it('여러 줄, 글꼴에 없는 글자, 윤곽 한도', () => {
    const one = bounds(textContours(src, { text: 'I', size: 10, center: [0, 0] }));
    const two = bounds(textContours(src, { text: 'I\nI', size: 10, center: [0, 0] }));
    expect(two.y1 - two.y0).toBeGreaterThan((one.y1 - one.y0) * 2);
    expect(missingChars(src, '가 똠\n')).toEqual(['똠']); // KS X 1001 밖
    const many = textContours(src, { text: '가나다라마바사아자차카타파하', size: 5, center: [0, 0] });
    expect(textSketchCommands(many, 'sk', new Set(), 10).warnings.join()).toContain('넘습니다');
  });
});
