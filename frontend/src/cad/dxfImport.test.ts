import { describe, expect, it } from 'vitest';
import { chainSegments, dxfSketchCommands, parseDxf } from './dxfImport';
import { CadCommandSchema } from './commandTypes';

/** 그룹 코드·값 쌍으로 최소 DXF */
const dxf = (entities: (string | number)[][], header: (string | number)[] = []) =>
  [
    ...(header.length ? ['0', 'SECTION', '2', 'HEADER', ...header.map(String), '0', 'ENDSEC'] : []),
    '0', 'SECTION', '2', 'ENTITIES',
    ...entities.flatMap((e) => e.map(String)),
    '0', 'ENDSEC', '0', 'EOF',
  ].join('\n');

const line = (x1: number, y1: number, x2: number, y2: number) => [0, 'LINE', 8, '0', 10, x1, 20, y1, 11, x2, 21, y2];

describe('DXF 가져오기', () => {
  it('선 네 개 사각형 → 닫힌 다각형 하나 (반시계)', () => {
    const s = parseDxf(dxf([line(0, 0, 0, 10), line(0, 10, 20, 10), line(20, 0, 20, 10), line(20, 0, 0, 0)]));
    expect(s.segs).toHaveLength(4);
    const r = dxfSketchCommands(s, 'sk', new Set());
    expect(r.counts).toEqual({ polygons: 1, paths: 0, circles: 0, ellipses: 0 });
    const poly = r.commands[0] as { type: string; points: [number, number][] };
    expect(poly.type).toBe('add_polygon');
    expect(poly.points).toHaveLength(4);
    let area = 0;
    poly.points.forEach((p, k) => {
      const q = poly.points[(k + 1) % 4]!;
      area += (p[0] * q[1] - q[0] * p[1]) / 2;
    });
    expect(area).toBeCloseTo(200);
    for (const c of r.commands) expect(CadCommandSchema.safeParse(c).success).toBe(true);
  });

  it('LWPOLYLINE bulge (슬롯 모양) → 호 변 2개, 인치 단위 → mm', () => {
    const s = parseDxf(
      dxf([[0, 'LWPOLYLINE', 90, 4, 70, 1, 10, 0, 20, 0, 10, 1, 20, 0, 42, 1, 10, 1, 20, 1, 10, 0, 20, 1, 42, 1]], [9, '$INSUNITS', 70, 1]),
    );
    expect(s.unitLabel).toBe('인치');
    const r = dxfSketchCommands(s, 'sk', new Set());
    const arcs = r.commands.filter((c) => c.type === 'set_arc') as { edge: number; bulge: number }[];
    expect(arcs.map((a) => a.edge).sort()).toEqual([1, 3]);
    expect(arcs.every((a) => Math.abs(Math.abs(a.bulge) - 1) < 1e-9)).toBe(true);
    const poly = r.commands[0] as { points: [number, number][] };
    expect(Math.max(...poly.points.map((p) => p[0]))).toBeCloseTo(25.4);
  });

  it('원·전체 타원·호 (반원 넘으면 조각), 열린 선 → 경로', () => {
    const s = parseDxf(
      dxf([
        [0, 'CIRCLE', 10, 5, 20, 5, 40, 3],
        [0, 'ELLIPSE', 10, 0, 20, 0, 11, 0, 21, 10, 40, 0.5, 41, 0, 42, 6.283185307179586],
        [0, 'ARC', 10, 0, 20, 0, 40, 10, 50, 0, 51, 270],
        line(100, 0, 110, 0),
      ]),
    );
    const r = dxfSketchCommands(s, 'sk', new Set(['c1']));
    expect(r.counts).toEqual({ polygons: 0, paths: 2, circles: 1, ellipses: 1 });
    const circle = r.commands.find((c) => c.type === 'add_circle') as { id: string; diameter: number };
    expect(circle).toMatchObject({ id: 'c2', diameter: 6 });
    const ell = r.commands.find((c) => c.type === 'add_ellipse') as { width: number; height: number; angle: number };
    expect(ell).toMatchObject({ width: 20, height: 10, angle: 90 });
    // 270° 호 → 반원 이하 두 조각 (경로 점 3개)
    const arcPath = r.commands.find((c) => c.type === 'add_path' && (c as { points: unknown[] }).points.length === 3);
    expect(arcPath).toBeTruthy();
  });

  it('반원 둘로 된 닫힌 원 → 점 셋 이상 다각형, |bulge|>1 호도 반원 이하로 나눔', () => {
    const s = parseDxf(dxf([[0, 'LWPOLYLINE', 90, 2, 70, 1, 10, -5, 20, 0, 42, 1, 10, 5, 20, 0, 42, 1]]));
    const r = dxfSketchCommands(s, 'sk', new Set());
    const poly = r.commands[0] as { type: string; points: unknown[] };
    expect(poly.type).toBe('add_polygon');
    expect(poly.points.length).toBeGreaterThanOrEqual(3);
    // 3/4 원 bulge = tan(270°/4) ≈ 2.414 → 두 조각, 가운데 점은 원 위 (반지름 5)
    const big = parseDxf(dxf([[0, 'LWPOLYLINE', 90, 2, 70, 0, 10, 5, 20, 0, 42, Math.tan((1.5 * Math.PI) / 4), 10, 0, 20, -5]]));
    expect(big.segs).toHaveLength(2);
    const mid = big.segs[0]!.b;
    expect(Math.hypot(mid[0], mid[1])).toBeCloseTo(5);
    expect(mid[0]).toBeCloseTo(-5 * Math.SQRT1_2);
  });

  it('SPLINE (3차 B-스플라인) → 끝점을 지나는 경로, 모르는 요소는 경고', () => {
    const s = parseDxf(
      dxf([
        [0, 'SPLINE', 71, 3, 40, 0, 40, 0, 40, 0, 40, 0, 40, 1, 40, 1, 40, 1, 40, 1, 10, 0, 20, 0, 10, 10, 20, 10, 10, 20, 20, 10, 10, 30, 20, 0],
        [0, 'TEXT', 10, 0, 20, 0, 1, 'hello'],
      ]),
    );
    expect(s.segs[0]!.a).toEqual([0, 0]);
    expect(s.segs[s.segs.length - 1]!.b[0]).toBeCloseTo(30);
    const r = dxfSketchCommands(s, 'sk', new Set());
    expect(r.counts.paths).toBe(1);
    expect(r.warnings.join()).toContain('TEXT 1');
  });

  it('-Z 돌출 방향(OCS) 은 x 반전, 요소 한도 넘으면 경고', () => {
    const s = parseDxf(dxf([[0, 'CIRCLE', 10, 5, 20, 1, 40, 1, 210, 0, 220, 0, 230, -1]]));
    expect(s.circles[0]!.c).toEqual([-5, 1]);
    const many = parseDxf(dxf(Array.from({ length: 5 }, (_, k) => [0, 'CIRCLE', 10, k * 10, 20, 0, 40, 1])));
    const r = dxfSketchCommands(many, 'sk', new Set(), 3);
    expect(r.counts.circles).toBe(3);
    expect(r.warnings.join()).toContain('2개는');
  });

  it('사슬: 뒤집힌 방향의 조각도 잇는다', () => {
    const chains = chainSegments([
      { a: [0, 0], b: [1, 0], bulge: 0 },
      { a: [1, 1], b: [1, 0], bulge: 0.2 },
      { a: [1, 1], b: [0, 0], bulge: 0 },
    ]);
    expect(chains).toHaveLength(1);
    expect(chains[0]!.closed).toBe(true);
    expect(chains[0]!.segs[1]).toEqual({ a: [1, 0], b: [1, 1], bulge: -0.2 });
  });

  it('DXF 가 아니면 오류', () => {
    expect(() => parseDxf('hello\nworld\nfoo')).toThrow('DXF');
  });
});
