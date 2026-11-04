/** 형식 v10 곡선 규칙과 명령 (서버 tests/test_curves.py 와 같은 값) */
import { describe, expect, it } from 'vitest';
import type { Point2 } from './commandTypes';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { executeCommand } from './commandExecutor';
import { cornerError, roundedPoints, sweepError, thinPolygon } from './curves';
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
