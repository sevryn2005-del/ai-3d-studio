/** 형식 v10 곡선 규칙과 명령 (서버 tests/test_curves.py 와 같은 값) */
import { describe, expect, it } from 'vitest';
import type { Point2 } from './commandTypes';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { executeCommand } from './commandExecutor';
import { bulgeArc, bulgeThrough, cornerError, cornerSegments, roundedPoints, sweepError, thinPolygon } from './curves';
import { drawShapeCommands } from './sketchActions';
import { resolveProfile, revolveProfileError } from './sketch';
import { signedArea } from './sections';
import { validateGraph } from './modelGraph';

const SQUARE: Point2[] = [[-10, -10], [10, -10], [10, 10], [-10, 10]];
const area = (p: Point2[]) => Math.abs(signedArea(p));

function run(cmds: unknown[], model: ModelDefinition = emptyModel()) {
  for (const c of cmds) {
    const r = executeCommand(model, c);
    if (!r.ok) throw new Error(r.error);
    model = r.model;
  }
  return model;
}
const err = (model: ModelDefinition, c: unknown) => {
  const r = executeCommand(model, c);
  return r.ok ? null : r.error;
};
const XY = { type: 'XY', offset: 0 } as const;

describe('곡선 규칙 (curves.ts)', () => {
  it('필렛·모따기 넓이', () => {
    expect(area(roundedPoints(SQUARE, [0, 1, 2, 3].map((k) => ({ k, type: 'fillet' as const, size: 3 })), true))).toBeCloseTo(400 - (4 - Math.PI) * 9, 0);
    expect(area(roundedPoints(SQUARE, [{ k: 0, type: 'chamfer', size: 3 }], true))).toBeCloseTo(395.5, 9);
  });
  it('들어가지 않는 꼭짓점 처리·경로 끝점', () => {
    expect(cornerError(SQUARE, [{ k: 0, type: 'fillet', size: 15 }], true)).toBeNull();
    expect(cornerError(SQUARE, [0, 1, 2, 3].map((k) => ({ k, type: 'fillet' as const, size: 11 })), true)).toMatch('변 길이');
    expect(cornerError([[0, 0], [10, 0], [10, 10]], [{ k: 0, type: 'fillet', size: 1 }], false)).toMatch('양 끝점');
  });
  it('얇은 단면 넓이 = 두께 × 중심선 길이', () => {
    expect(area(thinPolygon([[0, 0], [20, 0], [20, 10]], 2))).toBeCloseTo(60, 9);
  });
  it('급한 꺾임은 스윕할 수 없다', () => {
    const prof: Point2[] = [[3, 0], [0, 3], [-3, 0], [0, -3]];
    expect(sweepError(prof, [[0, 0], [2, 0], [2, 10]])).toMatch('급하게');
    expect(sweepError(prof, [[0, 0], [20, 0], [20, 10]])).toBeNull();
  });
});

describe('형식 v10 명령', () => {
  const base = run([
    { type: 'create_sketch', id: 's', plane: XY },
    { type: 'add_path', sketch: 's', id: 'pa', points: [[0, 0], [20, 0.5], [20, 10]] },
    { type: 'add_rectangle', sketch: 's', id: 'r', center: [50, 0], width: 4, height: 4 },
  ]);

  it('경로 변은 구속할 수 있고(e0·e1), 닫는 변(e2)은 없다', () => {
    const m = run([{ type: 'add_constraint', sketch: 's', constraint: 'horizontal', refs: ['pa.e0'] }], base);
    const pa = m.sketches[0]!.entities.find((e) => e.id === 'pa') as { points: Point2[] };
    expect(pa.points[1]![1]).toBeCloseTo(pa.points[0]![1], 6);
    expect(err(base, { type: 'add_constraint', sketch: 's', constraint: 'horizontal', refs: ['pa.e2'] })).toMatch('pa.e2');
  });

  it('스케치 필렛: 사각형에는 안내, 경로 끝점은 거부, 0 이면 제거', () => {
    expect(err(base, { type: 'set_corner', sketch: 's', entity: 'r', corner: 'fillet', size: 1 })).toMatch('다각형');
    expect(err(base, { type: 'set_corner', sketch: 's', entity: 'pa', vertices: [0], corner: 'fillet', size: 1 })).toMatch('양 끝점');
    const m = run([{ type: 'set_corner', sketch: 's', entity: 'pa', corner: 'fillet', size: 3 }], base);
    expect(m.sketches[0]!.entities.find((e) => e.id === 'pa')).toMatchObject({ corners: [{ k: 1, type: 'fillet', size: 3 }] });
    const off = run([{ type: 'set_corner', sketch: 's', entity: 'pa', corner: 'fillet', size: 0 }], m);
    expect(off.sketches[0]!.entities.find((e) => e.id === 'pa')).not.toHaveProperty('corners');
  });

  it('리브: 열린 선 + 두께만, 이름은 리브 n', () => {
    expect(err(base, { type: 'extrude', sketch: 's', profile: 'pa', distance: 5 })).toMatch('리브');
    expect(err(base, { type: 'extrude', sketch: 's', profile: 'r', distance: 5, thin: 2 })).toMatch('열린 선');
    const m = run([{ type: 'extrude', sketch: 's', profile: 'pa', distance: 5, thin: 2 }], base);
    expect(m.objects[0]).toMatchObject({ name: '리브 1', extrude: { thin: 2 } });
    expect(validateGraph(m)).toEqual([]);
  });

  it('스윕: 단면은 닫힌 요소, 경로는 열린 선, 쓰이는 경로는 지울 수 없다', () => {
    expect(err(base, { type: 'sweep', sketch: 's', profile: 'pa', pathSketch: 's', path: 'pa' })).toMatch('단면');
    expect(err(base, { type: 'sweep', sketch: 's', profile: 'r', pathSketch: 's', path: 'r' })).toMatch('경로');
    const m = run([{ type: 'sweep', sketch: 's', profile: 'r', pathSketch: 's', path: 'pa' }], base);
    expect(m.objects[0]).toMatchObject({ kind: 'sweep', name: '스윕 1' });
    expect(err(m, { type: 'delete_sketch_entity', sketch: 's', entity: 'pa' })).toMatch('삭제할 수 없습니다');
    expect(validateGraph(m)).toEqual([]);
  });
});

describe('형식 v13 호 변·사각형 → 다각형·대칭 구속 (서버 tests/test_curves.py 와 같은 값)', () => {
  it('bulge 호: 반원(1)·볼록 방향·각도', () => {
    const half = bulgeArc([10, -10], [10, 10], 1);
    expect(half).toMatchObject({ type: 'arc', r: 10, ccw: true });
    if (half.type !== 'arc') throw new Error();
    expect(half.c[0]).toBeCloseTo(10, 12);
    expect(half.mid).toEqual([20, 0]);
    expect(half.sweep).toBeCloseTo(Math.PI, 12);
    const inward = bulgeArc([10, -10], [10, 10], -Math.tan(Math.PI / 8)); // 90° 호, 안쪽으로
    if (inward.type !== 'arc') throw new Error();
    expect(inward.ccw).toBe(false);
    expect(inward.r).toBeCloseTo(Math.SQRT2 * 10, 9);
    expect(inward.mid[0]).toBeLessThan(10);
  });
  it('호 변 넓이: 반원을 붙이면 400 + 50π (표본 오차 1% 미만)', () => {
    const p = roundedPoints(SQUARE, undefined, true, undefined, [{ k: 1, bulge: 1 }]);
    expect(Math.abs(area(p) - (400 + 50 * Math.PI)) / (400 + 50 * Math.PI)).toBeLessThan(1e-2);
    expect(cornerSegments(SQUARE, undefined, true, [{ k: 1, bulge: 1 }]).map((s) => s.type)).toEqual(['line', 'arc', 'line', 'line']);
  });
  it('호 변 오류: 없는 변, 호에 붙은 꼭짓점 필렛', () => {
    expect(cornerError(SQUARE, undefined, true, [{ k: 4, bulge: 1 }])).toMatch('e4');
    expect(cornerError([[0, 0], [10, 0], [10, 10]], undefined, false, [{ k: 2, bulge: 1 }])).toMatch('e2');
    expect(cornerError(SQUARE, [{ k: 2, type: 'fillet', size: 1 }], true, [{ k: 1, bulge: 1 }])).toMatch('호 변');
    expect(cornerError(SQUARE, [{ k: 3, type: 'fillet', size: 1 }], true, [{ k: 1, bulge: 1 }])).toBeNull();
  });

  const base = run([
    { type: 'create_sketch', id: 's', plane: XY },
    { type: 'add_polygon', sketch: 's', id: 'p', points: SQUARE },
    { type: 'add_rectangle', sketch: 's', id: 'r', center: [50, 0], width: 20, height: 10 },
    { type: 'add_circle', sketch: 's', id: 'c', center: [-50, 0], diameter: 4 },
  ]);
  const ent = (m: ModelDefinition, id: string) => m.sketches[0]!.entities.find((e) => e.id === id) as Record<string, unknown>;

  it('set_arc: 다각형·경로만, 변 범위, 0 이면 제거, 다시 주면 바꿈', () => {
    expect(err(base, { type: 'set_arc', sketch: 's', entity: 'r', edge: 0, bulge: 1 })).toMatch('다각형');
    expect(err(base, { type: 'set_arc', sketch: 's', entity: 'c', edge: 0, bulge: 1 })).toMatch('다각형');
    expect(err(base, { type: 'set_arc', sketch: 's', entity: 'p', edge: 4, bulge: 1 })).toMatch('e4');
    const m = run([{ type: 'set_arc', sketch: 's', entity: 'p', edge: 1, bulge: 0.5 }], base);
    expect(ent(m, 'p').arcs).toEqual([{ k: 1, bulge: 0.5 }]);
    const m2 = run([{ type: 'set_arc', sketch: 's', entity: 'p', edge: 1, bulge: -0.25 }], m);
    expect(ent(m2, 'p').arcs).toEqual([{ k: 1, bulge: -0.25 }]);
    const off = run([{ type: 'set_arc', sketch: 's', entity: 'p', edge: 1, bulge: 0 }], m2);
    expect(ent(off, 'p')).not.toHaveProperty('arcs');
    expect(validateGraph(m2)).toEqual([]);
  });

  it('convert_to_polygon: 같은 id 의 반시계 다각형, 치수는 지운다', () => {
    const withDim = run([{ type: 'set_dimension', sketch: 's', dimension: 'r.width', value: 30 }], base);
    expect(withDim.sketches[0]!.dimensions.length).toBeGreaterThan(0);
    const m = run([{ type: 'convert_to_polygon', sketch: 's', entity: 'r' }], withDim);
    expect(ent(m, 'r')).toEqual({ id: 'r', type: 'polygon', points: [[35, -5], [65, -5], [65, 5], [35, 5]] });
    expect(m.sketches[0]!.dimensions.filter((d) => d.entity === 'r')).toEqual([]);
    expect(err(m, { type: 'convert_to_polygon', sketch: 's', entity: 'r' })).toMatch('사각형');
    expect(err(base, { type: 'convert_to_polygon', sketch: 's', entity: 'c' })).toMatch('사각형');
  });
});

describe('형식 v15 세 점 호·영역 단면', () => {
  it('bulgeThrough: 반원·사분원·방향·직선·반원 넘는 호', () => {
    // a(0,0) → b(10,0), 오른쪽(아래) 반원 위 점 (5,-5) → +1 (반시계)
    expect(bulgeThrough([0, 0], [10, 0], [5, -5])).toEqual({ bulge: 1, clamped: false });
    expect(bulgeThrough([0, 0], [10, 0], [5, 5])).toEqual({ bulge: -1, clamped: false });
    // 90° 호: 중심 (5, 5), 반지름 √50, 아래쪽 가운데 점
    const q = bulgeThrough([0, 0], [10, 0], [5, 5 - Math.sqrt(50)])!;
    expect(q.bulge).toBeCloseTo(Math.tan(Math.PI / 8), 6);
    // bulgeArc 로 되돌리면 지난 점이 호 가운데
    const arc = bulgeArc([0, 0], [10, 0], q.bulge);
    if (arc.type !== 'arc') throw new Error();
    expect(arc.mid[1]).toBeCloseTo(5 - Math.sqrt(50), 4);
    expect(bulgeThrough([0, 0], [10, 0], [20, 0])).toBeNull();
    expect(bulgeThrough([0, 0], [10, 0], [5, -20])).toEqual({ bulge: 1, clamped: true });
  });

  it('호 그리기 → 경로 + 호 변 (실행 취소 1번)', () => {
    const cmds = drawShapeCommands(emptyModel(), null, { type: 'arc', from: [0, 0], to: [10, 0], through: [5, -5] })!;
    expect(cmds.map((c) => (c as { type: string }).type)).toEqual(['create_sketch', 'add_path', 'set_arc']);
    const m = run(cmds);
    expect(m.sketches[0]!.entities[0]).toMatchObject({ id: 'arc1', type: 'path', points: [[0, 0], [10, 0]], arcs: [{ k: 0, bulge: 1 }] });
    expect(drawShapeCommands(emptyModel(), null, { type: 'arc', from: [0, 0], to: [10, 0], through: [3, 0] })).toBeNull();
  });

  const base = run([
    { type: 'create_sketch', id: 's', plane: XY },
    { type: 'add_rectangle', sketch: 's', id: 'r', center: [0, 0], width: 40, height: 20 },
    { type: 'add_circle', sketch: 's', id: 'c', center: [10, 0], diameter: 6 },
    { type: 'add_path', sketch: 's', id: 'pa', points: [[0, 0], [10, 0]] },
  ]);
  const items = [{ entity: 'r', op: 'add' }, { entity: 'c', op: 'subtract' }];

  it('add_region·set_region: 규칙 검사, 돌출 가능, 자동 ID', () => {
    const m = run([{ type: 'add_region', sketch: 's', items }], base);
    expect(m.sketches[0]!.entities.at(-1)).toEqual({ id: 'region1', type: 'region', items });
    expect(validateGraph(m)).toEqual([]);
    const ex = run([{ type: 'extrude', sketch: 's', profile: 'region1', distance: 5 }], m);
    expect(ex.objects).toHaveLength(1);
    expect(err(base, { type: 'add_region', sketch: 's', items: [{ entity: 'c', op: 'subtract' }] })).toMatch('첫 요소');
    expect(err(base, { type: 'add_region', sketch: 's', items: [{ entity: 'r', op: 'add' }, { entity: 'pa', op: 'add' }] })).toMatch('닫힌 요소');
    expect(err(base, { type: 'add_region', sketch: 's', items: [{ entity: 'r', op: 'add' }, { entity: 'r', op: 'subtract' }] })).toMatch('두 번');
    const m2 = run([{ type: 'set_region', sketch: 's', entity: 'region1', items: [{ entity: 'r', op: 'add' }, { entity: 'c', op: 'add' }] }], m);
    expect((m2.sketches[0]!.entities.at(-1) as { items: unknown[] }).items).toEqual([{ entity: 'r', op: 'add' }, { entity: 'c', op: 'add' }]);
    expect(err(m, { type: 'set_region', sketch: 's', entity: 'r', items })).toMatch('영역');
  });

  it('영역이 쓰는 요소는 지울 수 없고, 영역은 옮기기·오프셋·스윕·헬릭스·로프트에 못 쓴다', () => {
    const m = run([{ type: 'add_region', sketch: 's', id: 'g', items }], base);
    expect(err(m, { type: 'delete_sketch_entity', sketch: 's', entity: 'c' })).toMatch('영역');
    expect(err(m, { type: 'set_entity_center', sketch: 's', entity: 'g', center: [1, 1] })).toMatch('영역');
    expect(err(m, { type: 'offset_entity', sketch: 's', entity: 'g', distance: 1 })).toMatch('영역');
    expect(err(m, { type: 'helix', sketch: 's', profile: 'g', pitch: 30, turns: 2 })).toMatch('돌출·회전에만');
    // 영역을 지우면 구성 요소도 지울 수 있다
    const m2 = run([{ type: 'delete_sketch_entity', sketch: 's', entity: 'g' }, { type: 'delete_sketch_entity', sketch: 's', entity: 'c' }], m);
    expect(m2.sketches[0]!.entities.map((e) => e.id)).toEqual(['r', 'pa']);
  });

  it('영역 단면 크기 = 합치는 단면들의 범위, 회전 축 검사', () => {
    const m = run([{ type: 'add_circle', sketch: 's', id: 'c2', center: [30, 0], diameter: 10 }, { type: 'add_region', sketch: 's', id: 'g', items: [...items, { entity: 'c2', op: 'add' }] }], base);
    const p = resolveProfile(m.sketches[0]!, 'g')!;
    expect(p).toMatchObject({ type: 'region', center: [7.5, 0], width: 55, height: 20 });
    expect(revolveProfileError(p)).toMatch('회전축');
  });
});
