import { describe, expect, it } from 'vitest';
import { CONSTRAINT_RECT_CORNER_COMMANDS, buildSketchPlateFixture } from './schemaExport';
import { groupBadges, sketchBadges } from './sketchRelations';
import { executeCommand } from './commandExecutor';

describe('구속·치수 기호', () => {
  const m = buildSketchPlateFixture(CONSTRAINT_RECT_CORNER_COMMANDS);
  const sk = m.sketches[0]!;
  it('고정·일치·중간점·수직 기호와 사각형 폭·높이', () => {
    const b = sketchBadges(sk);
    const texts = b.map((x) => x.text);
    expect(texts).toEqual(expect.arrayContaining(['⊕', '●', 'M', '｜', '40', '20']));
    // 고정은 사각형 왼쪽 아래 모서리 (−17, −12)
    expect(b.find((x) => x.text === '⊕')!.at).toEqual([-17, -12]);
    // 같은 자리 묶기: 일치(오른쪽 위 모서리)는 단독
    expect(groupBadges(b).length).toBeLessThanOrEqual(b.length);
  });

  it('사각형 모서리를 끌면(move_point) 중심이 따라오고 구속이 다시 풀린다', () => {
    const r = executeCommand(m, { type: 'move_point', sketch: 's', point: 'r.p2', to: [30, 10] });
    // 왼쪽 아래 모서리가 고정이라 사각형은 못 움직인다 → 거부되거나 그대로
    if (r.ok) {
      const rect = r.model.sketches[0]!.entities.find((e) => e.id === 'r') as { center: number[] };
      expect(rect.center).toEqual([3, -2]);
    }
    const free = executeCommand(m, { type: 'delete_constraint', sketch: 's', constraint: 'fix_corner' });
    if (!free.ok) throw new Error(free.error);
    const moved = executeCommand(free.model, { type: 'move_point', sketch: 's', point: 'r.p2', to: [30, 10] });
    if (!moved.ok) throw new Error(moved.error);
    const sk2 = moved.model.sketches[0]!;
    expect((sk2.entities.find((e) => e.id === 'r') as { center: number[] }).center).toEqual([10, 0]);
    // 삼각형 첫 점은 모서리를 따라온다 (일치 구속)
    expect((sk2.entities.find((e) => e.id === 'tri') as { points: number[][] }).points[0]).toEqual([30, 10]);
  });
});
