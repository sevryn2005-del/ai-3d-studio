import { describe, expect, it } from 'vitest';
import { Matrix4, Path, Shape, ShapeGeometry } from 'three';
import { convertCommands, faceLoops, loopShape, projectLoops } from './faceOutline';
import { executeBatch } from './commandExecutor';
import { emptyModel } from './commandTypes';
import { resolveProfile } from './sketch';

/** 40×30 판 + 지름 10 원 구멍 + 8×6 사각 구멍 (z = 5 면) */
function plateFace() {
  const s = new Shape([[-20, -15], [20, -15], [20, 15], [-20, 15]].map(([x, y]) => ({ x, y }) as never));
  const hole = new Path();
  hole.absarc(-8, 0, 5, 0, Math.PI * 2, true);
  s.holes.push(hole);
  const sq = new Path();
  sq.moveTo(6, -3);
  sq.lineTo(6, 3);
  sq.lineTo(14, 3);
  sq.lineTo(14, -3);
  sq.lineTo(6, -3);
  s.holes.push(sq);
  const g = new ShapeGeometry(s, 32).translate(0, 0, 5);
  return { positions: g.getAttribute('position').array, indices: g.index!.array };
}

describe('요소 변환 (면 윤곽 → 스케치)', () => {
  it('경계 고리: 바깥 1 + 구멍 2', () => {
    const f = plateFace();
    expect(faceLoops(f.positions, f.indices)).toHaveLength(3);
  });
  it('원은 원 요소로, 사각형은 꼭짓점 4개 다각형으로 (한 직선 위 점 빼기)', () => {
    const circle = Array.from({ length: 32 }, (_, i) => [3 + 5 * Math.cos((i / 32) * 2 * Math.PI), 4 + 5 * Math.sin((i / 32) * 2 * Math.PI)] as [number, number]);
    expect(loopShape(circle)).toEqual({ type: 'circle', center: [3, 4], diameter: 10 });
    expect(loopShape([[0, 0], [5, 0], [10, 0], [10, 10], [0, 10]])).toEqual({ type: 'polygon', points: [[0, 0], [10, 0], [10, 10], [0, 10]] });
    // 시계 방향은 반시계로
    expect(loopShape([[0, 0], [0, 10], [10, 10], [10, 0]])).toMatchObject({ points: [[10, 0], [10, 10], [0, 10], [0, 0]] });
  });
  it('점이 많은 곡선 윤곽은 64점 이하로 줄인다', () => {
    const blob = Array.from({ length: 300 }, (_, i) => {
      const t = (i / 300) * 2 * Math.PI;
      const r = 20 + 4 * Math.sin(5 * t);
      return [r * Math.cos(t), r * Math.sin(t)] as [number, number];
    });
    const s = loopShape(blob);
    expect(s?.type).toBe('polygon');
    expect(s!.type === 'polygon' && s!.points.length).toBeLessThanOrEqual(64);
  });
  it('스케치 명령: 바깥 − 구멍 영역이 돌출 단면, 스케치 평면(z = 5)에 투영', () => {
    const f = plateFace();
    const sketchWorld = new Matrix4().makeTranslation(0, 0, 5);
    const loops = projectLoops(faceLoops(f.positions, f.indices), sketchWorld);
    const base = executeBatch(emptyModel(), [{ type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 5 } }]);
    if (!base.ok) throw new Error(base.error);
    const r = convertCommands(base.model.sketches[0]!, loops);
    if (!r.ok) throw new Error(r.error);
    expect(r.holes).toBe(2);
    expect(r.commands.map((c) => c.type)).toEqual(['add_polygon', 'add_circle', 'add_polygon', 'add_region']);
    const done = executeBatch(base.model, [...r.commands, { type: 'extrude', id: 'e', sketch: 's', profile: r.profile, distance: 3 }]);
    if (!done.ok) throw new Error(done.error);
    const prof = resolveProfile(done.model.sketches[0]!, r.profile);
    expect(prof?.type).toBe('region');
    const circle = done.model.sketches[0]!.entities.find((e) => e.type === 'circle')!;
    expect(circle.type === 'circle' && circle.center).toEqual([-8, 0]);
  });
});
