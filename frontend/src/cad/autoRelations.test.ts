import { describe, expect, it } from 'vitest';
import { centerRelations, drawnTarget, polylineRelations, withRelations } from './autoRelations';
import { emptyModel, type Point2 } from './commandTypes';
import { drawShapeCommands } from './sketchActions';
import { executeBatch } from './commandExecutor';
import { degreesOfFreedom } from './solver';

const square: Point2[] = [[0, 0], [20, 0], [20, 10], [0, 10]];

describe('자동 구속', () => {
  it('가로·세로 변 → 수평·수직, 원점 → 고정, 입력 길이 → 길이', () => {
    const rels = polylineRelations('poly1', square, [{ snap: { kind: 'origin', guides: [] } }, { length: 20 }, {}, {}], { closed: true, straight: true });
    expect(rels).toEqual([
      { constraint: 'fix', refs: ['poly1.p0'] },
      { constraint: 'horizontal', refs: ['poly1.e0'] },
      { constraint: 'length', refs: ['poly1.e0'], value: 20 },
      { constraint: 'vertical', refs: ['poly1.e1'] },
      { constraint: 'horizontal', refs: ['poly1.e2'] },
      { constraint: 'vertical', refs: ['poly1.e3'] },
    ]);
  });

  it('다른 요소 점에 붙음 → 일치, 정렬 안내 → 두 점 수평, 같은 도형의 이웃 점은 건너뜀', () => {
    const rels = polylineRelations('path2', [[0, 0], [5, 5], [9, 0]], [
      { snap: { kind: 'center', ref: 'c1.center', guides: [] } },
      { snap: { kind: 'free', guides: [{ dir: 'h', from: [0, 5], ref: 'r1.center' }, { dir: 'v', from: [0, 0], ref: '@0' }] } },
      { snap: { kind: 'free', guides: [{ dir: 'h', from: [0, 0], ref: '@0' }] } },
    ], { closed: false, straight: false });
    expect(rels).toEqual([
      { constraint: 'coincident', refs: ['path2.p0', 'c1.center'] },
      { constraint: 'horizontal', refs: ['path2.p1', 'r1.center'] },
      { constraint: 'horizontal', refs: ['path2.p2', 'path2.p0'] },
    ]);
    expect(centerRelations('c2', { kind: 'endpoint', ref: 'poly1.p2', guides: [] })).toEqual([{ constraint: 'coincident', refs: ['c2.center', 'poly1.p2'] }]);
  });

  it('실제 모델: 정사각형 구속이 모두 들어가고, 모순되는 구속은 건너뛴다', () => {
    const model = emptyModel();
    const base = drawShapeCommands(model, null, { type: 'polygon', points: square })!;
    const t = drawnTarget(base)!;
    expect(t.entity).toBe('poly1');
    const rels = polylineRelations(t.entity, square, [{ snap: { kind: 'origin', guides: [] } }, { length: 20 }, {}, {}], { closed: true, straight: true });
    // 일부러 모순: 같은 변에 다른 길이
    const { commands, added } = withRelations(model, base, t.sketch, [...rels, { constraint: 'length', refs: ['poly1.e0'], value: 33 }]);
    expect(added).toBe(rels.length);
    const r = executeBatch(model, commands);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const sk = r.model.sketches[0]!;
    expect(sk.constraints).toHaveLength(rels.length);
    // 고정(2) + 수평·수직 4 + 길이 1 → 남은 자유도 = 8 − 7 = 1 (높이)
    expect(degreesOfFreedom(sk)).toBe(1);
  });
});
