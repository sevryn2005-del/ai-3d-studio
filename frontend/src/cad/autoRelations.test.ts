import { describe, expect, it } from 'vitest';
import { centerRelations, drawnTarget, polylineRelations, rectRelations, withRelations } from './autoRelations';
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

  it('사각형 모서리 → 일치, 변 가운데 → 중간점, 새 사각형 모서리도 붙은 점과 일치', () => {
    expect(polylineRelations('path1', [[20, 10], [20, 0]], [
      { snap: { kind: 'endpoint', ref: 'r1.p2', guides: [] } },
      { snap: { kind: 'midpoint', edge: 'r1.e1', guides: [] } },
    ], { closed: false, straight: true })).toEqual([
      { constraint: 'coincident', refs: ['path1.p0', 'r1.p2'] },
      { constraint: 'midpoint', refs: ['path1.p1', 'r1.e1'] },
      { constraint: 'vertical', refs: ['path1.e0'] },
    ]);
    // 오른쪽 위에서 왼쪽 아래로 드래그: 시작 = p2, 끝 = p0
    expect(rectRelations('r2', [10, 10], [0, 0], { kind: 'endpoint', ref: 'poly1.p1', guides: [] }, { kind: 'origin', guides: [] })).toEqual([
      { constraint: 'coincident', refs: ['r2.p2', 'poly1.p1'] },
      { constraint: 'fix', refs: ['r2.p0'] },
    ]);
  });

  it('실제 모델: 사각형 모서리·변 가운데에 붙여 그린 경로가 구속된다', () => {
    let model = emptyModel();
    const rect = drawShapeCommands(model, null, { type: 'rectangle', from: [-20, -10], to: [20, 10] })!;
    const r0 = executeBatch(model, rect);
    if (!r0.ok) throw new Error(r0.error);
    model = r0.model;
    const sid = model.sketches[0]!.id;
    const pts: Point2[] = [[20, 10], [20, 0], [35, 0]];
    const base = drawShapeCommands(model, sid, { type: 'path', points: pts })!;
    const rels = polylineRelations(drawnTarget(base)!.entity, pts, [
      { snap: { kind: 'endpoint', ref: 'r1.p2', guides: [] } },
      { snap: { kind: 'midpoint', edge: 'r1.e1', guides: [] } },
      {},
    ], { closed: false, straight: true });
    const { commands, added } = withRelations(model, base, sid, rels);
    expect(added).toBe(rels.length);
    const r = executeBatch(model, commands);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.model.sketches[0]!.constraints.map((c) => c.type).sort()).toEqual(['coincident', 'horizontal', 'midpoint', 'vertical']);
  });
});
