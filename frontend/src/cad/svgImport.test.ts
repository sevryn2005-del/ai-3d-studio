import { describe, expect, it } from 'vitest';
import { parseSvg } from './svgImport';
import { chainSegments, dxfSketchCommands } from './dxfImport';
import { CadCommandSchema, LIMITS } from './commandTypes';

const svg = (body: string, attrs = 'width="100mm" height="50mm" viewBox="0 0 100 50"') => `<?xml version="1.0"?>\n<!-- 주석 <rect/> -->\n<svg xmlns="http://www.w3.org/2000/svg" ${attrs}>${body}</svg>`;

describe('SVG 가져오기', () => {
  it('mm viewBox: rect → 닫힌 다각형 (y 뒤집힘: 위가 +v), 원 → 원', () => {
    const s = parseSvg(svg('<rect x="10" y="10" width="20" height="10"/><circle cx="50" cy="25" r="5"/>'));
    expect(s.unitLabel).toBe('mm');
    const r = dxfSketchCommands(s, 'sk', new Set());
    expect(r.counts).toEqual({ polygons: 1, paths: 0, circles: 1, ellipses: 0 });
    const poly = r.commands[0] as { points: [number, number][] };
    const ys = poly.points.map((p) => p[1]);
    expect(Math.max(...ys)).toBeCloseTo(-10);
    expect(Math.min(...ys)).toBeCloseTo(-20);
    expect(r.commands.find((c) => c.type === 'add_circle')).toMatchObject({ center: [50, -25], diameter: 10 });
    for (const c of r.commands) expect(CadCommandSchema.safeParse(c).success).toBe(true);
  });

  it('px 단위(viewBox 없음) = 96dpi, 둥근 rect = 호 변 4개', () => {
    const s = parseSvg(svg('<rect x="0" y="0" width="96" height="96" rx="12"/>', 'width="96" height="96"'));
    const r = dxfSketchCommands(s, 'sk', new Set());
    const poly = r.commands[0] as { points: [number, number][] };
    const xs = poly.points.map((p) => p[0]);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(25.4, 4);
    const arcs = r.commands.filter((c) => c.type === 'set_arc') as { bulge: number }[];
    expect(arcs).toHaveLength(4);
    for (const a of arcs) expect(a.bulge).toBeCloseTo(Math.tan(Math.PI / 8), 6); // 90° 호, 반시계로 맞춤
  });

  it('path: 상대 명령·H/V·Z, 원호 A (반원 둘 = 원 모양 닫힌 윤곽), 베지어는 잘게', () => {
    const s = parseSvg(svg('<path d="M10 10 h20 v10 h-20 z M60,25 a10,10 0 1,0 20,0 a10 10 0 1 0 -20 0"/><path d="M0 40 C 10 30, 20 50, 30 40"/>'));
    const chains = chainSegments(s.segs);
    expect(chains.filter((c) => c.closed)).toHaveLength(2);
    const circleChain = chains.find((c) => c.closed && c.segs.some((sg) => sg.bulge !== 0))!;
    expect(circleChain.segs).toHaveLength(2);
    for (const sg of circleChain.segs) expect(Math.abs(sg.bulge)).toBeCloseTo(1, 6);
    const open = chains.find((c) => !c.closed)!;
    expect(open.segs.length).toBeGreaterThan(4); // 베지어를 꺾은선으로
    expect(open.segs[0]!.a).toEqual([0, -40]);
  });

  it('transform: <g translate> 안 rotate 된 타원, scale 이 다르면 타원 호는 꺾은선', () => {
    const s = parseSvg(svg('<g transform="translate(50 25)"><ellipse rx="10" ry="5" transform="rotate(30)"/></g><g transform="scale(2 1)"><circle cx="10" cy="10" r="2"/></g>'));
    expect(s.ellipses).toHaveLength(1);
    expect(s.ellipses[0]).toMatchObject({ c: [50, -25], w: 20, h: 10 });
    expect(s.ellipses[0]!.angle).toBeCloseTo(-30); // 화면에서 시계 방향 30° = 스케치에서 −30°
    expect(s.circles).toHaveLength(0);
    expect(chainSegments(s.segs).filter((c) => c.closed)).toHaveLength(1); // 늘어난 원 = 닫힌 꺾은선
  });

  it('defs·숨긴 요소는 건너뛰고 text·image 는 알림, 점이 많은 윤곽은 단순화', () => {
    const many = Array.from({ length: 200 }, (_, k) => {
      const t = (2 * Math.PI * k) / 200;
      return `${(50 + 20 * Math.cos(t)).toFixed(4)},${(25 + 20 * Math.sin(t)).toFixed(4)}`;
    }).join(' ');
    const s = parseSvg(svg(`<defs><rect width="5" height="5"/></defs><rect width="5" height="5" style="display:none"/><text x="1">hi</text><image href="a.png"/><polygon points="${many}"/>`));
    expect(s.skipped).toMatchObject({ text: 1, image: 1 });
    const r = dxfSketchCommands(s, 'sk', new Set());
    expect(r.counts.polygons).toBe(1);
    expect((r.commands[0] as { points: unknown[] }).points.length).toBeLessThanOrEqual(LIMITS.maxPolygonPoints);
    expect(r.warnings.join()).toContain('단순화');
  });

  it('SVG 가 아니면 오류', () => {
    expect(() => parseSvg('<html></html>')).toThrow('SVG');
  });
});
