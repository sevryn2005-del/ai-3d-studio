/** 조립 메이트 (형식 v11) — 서버 tests/test_mates.py 가 같은 잔차 규칙을 검사한다 */
import { describe, expect, it } from 'vitest';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { executeCommand } from './commandExecutor';
import { mateDof, mateResiduals } from './mates';
import { validateGraph } from './modelGraph';

function run(cmds: unknown[], model: ModelDefinition = emptyModel()) {
  for (const c of cmds) {
    const r = executeCommand(model, c);
    if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.error}`);
    model = r.model;
  }
  return model;
}
const err = (model: ModelDefinition, c: unknown) => {
  const r = executeCommand(model, c);
  return r.ok ? null : r.error;
};
const obj = (m: ModelDefinition, id: string) => m.objects.find((o) => o.id === id)!;

const two = run([
  { type: 'create_box', id: 'base', width: 40, depth: 40, height: 10 },
  { type: 'create_box', id: 'cap', width: 20, depth: 20, height: 5, position: [50, 30, 7] },
  { type: 'set_transform', target: 'cap', rotation: [10, 0, 25] },
]);

describe('메이트 풀이', () => {
  it('일치: 뚜껑 바닥이 받침 윗면에 붙는다 (첫 부품 고정, 회전은 맞추고 옆 위치는 최소 이동)', () => {
    const m = run([{ type: 'add_mate', mate: 'coincident', refs: ['base.top', 'cap.bottom'] }], two);
    expect(obj(m, 'base').transform).toEqual(obj(two, 'base').transform);
    const cap = obj(m, 'cap').transform;
    expect(cap.position[2]).toBeCloseTo(10, 5);
    expect(cap.rotation[0]).toBeCloseTo(0, 4);
    expect(cap.rotation[1]).toBeCloseTo(0, 4);
    expect(Math.max(...mateResiduals(m).values())).toBeLessThan(1e-5);
    expect(validateGraph(m)).toEqual([]);
    expect(mateDof(m)).toBe(3); // 평면 위에서 미끄러짐 2 + 돌기 1
  });

  it('동심 + 거리 → 축 둘레 회전만 남음, 거리 바꾸면 따라온다', () => {
    const m = run([
      { type: 'create_cylinder', id: 'boss', radius: 6, height: 8 }, // 먼저 만든 부품 = 고정
      { type: 'create_cylinder', id: 'pin', radius: 3, height: 20, position: [80, 0, 0] },
      { type: 'add_mate', id: 'c1', mate: 'concentric', refs: ['boss.axis', 'pin.axis'] },
      { type: 'add_mate', id: 'd1', mate: 'distance', refs: ['boss.top', 'pin.bottom'], value: 2, flip: false },
    ]);
    expect(obj(m, 'pin').transform.position[0]).toBeCloseTo(0, 5);
    expect(obj(m, 'pin').transform.position[2]).toBeCloseTo(10, 5);
    expect(mateDof(m)).toBe(1); // 축 둘레 회전만 남음
    const m2 = run([{ type: 'set_mate', mate: 'd1', value: 5 }], m);
    expect(obj(m2, 'pin').transform.position[2]).toBeCloseTo(13, 5);
  });

  it('메이트된 부품을 옮기면 옮긴 부품은 그 자리, 짝이 따라온다', () => {
    const m = run([{ type: 'add_mate', mate: 'coincident', refs: ['base.top', 'cap.bottom'] }], two);
    const moved = run([{ type: 'translate', target: 'base', offset: [0, 0, 5] }], m);
    expect(obj(moved, 'base').transform.position[2]).toBeCloseTo(5, 6);
    expect(obj(moved, 'cap').transform.position[2]).toBeCloseTo(15, 5);
  });

  it('치수가 바뀌어도 메이트를 지킨다 (받침 높이 10 → 30)', () => {
    const m = run([{ type: 'add_mate', mate: 'coincident', refs: ['base.top', 'cap.bottom'] }], two);
    const taller = run([{ type: 'set_params', target: 'base', params: { height: 30 } }], m);
    expect(obj(taller, 'cap').transform.position[2]).toBeCloseTo(30, 5);
  });

  it('고정·모순·잘못된 참조', () => {
    const fixed = run([
      { type: 'add_mate', mate: 'fix', refs: ['cap'] },
      { type: 'add_mate', mate: 'coincident', refs: ['base.top', 'cap.bottom'] },
    ], two);
    expect(obj(fixed, 'cap').transform).toEqual(obj(two, 'cap').transform); // 고정된 뚜껑 대신 받침이 움직인다
    const both = run([{ type: 'add_mate', mate: 'fix', refs: ['base'] }], fixed);
    expect(err(both, { type: 'add_mate', mate: 'distance', refs: ['base.top', 'cap.bottom'], value: 3 })).toMatch('동시에 만족');
    expect(err(two, { type: 'add_mate', mate: 'concentric', refs: ['base.top', 'cap.bottom'] })).toMatch('축끼리');
    expect(err(two, { type: 'add_mate', mate: 'coincident', refs: ['base.axis', 'cap.bottom'] })).toMatch('축');
    expect(err(two, { type: 'add_mate', mate: 'coincident', refs: ['base.top', 'base.bottom'] })).toMatch('같은 객체');
  });

  it('메이트된 부품을 빼기 도구로 넣으면 거부, 지우면 메이트도 지워진다', () => {
    const m = run([{ type: 'add_mate', mate: 'coincident', refs: ['base.top', 'cap.bottom'] }], two);
    expect(err(m, { type: 'cut', base: 'base', tools: ['cap'] })).toMatch('메이트');
    const gone = run([{ type: 'delete_object', target: 'cap' }], m);
    expect(gone.mates ?? []).toEqual([]);
  });
});

describe('부품 삽입', () => {
  it('ID 를 다시 붙이고, 최상위가 여럿이면 하나의 부품(합치기)으로', () => {
    const part = run([
      { type: 'create_sketch', id: 'sketch_1', plane: { type: 'XY', offset: 0 } },
      { type: 'add_rectangle', sketch: 'sketch_1', id: 'r1', center: [0, 0], width: 10, height: 10 },
      { type: 'extrude', id: 'base', sketch: 'sketch_1', profile: 'r1', distance: 3 },
      { type: 'create_cylinder', id: 'cylinder_1', radius: 2, height: 8 },
    ]);
    const m = run([{ type: 'insert_part', name: '브래킷', part: { sketches: part.sketches, objects: part.objects }, position: [100, 0, 0] }], two);
    expect(validateGraph(m)).toEqual([]);
    const ids = m.objects.map((o) => o.id);
    expect(ids).toContain('base_p1'); // 기존 base 와 겹쳐서 꼬리표
    expect(m.objects.find((o) => o.id === 'base_p1')).toMatchObject({ extrude: { sketch: 'sketch_1_p1' } });
    const group = m.objects.find((o) => o.name === '브래킷')!;
    expect(group).toMatchObject({ kind: 'boolean', boolean: { operation: 'union', base: 'base_p1', tools: ['cylinder_1_p1'] }, transform: { position: [100, 0, 0] } });
  });

  it('메이트 지키며 끌기: 면 위에서는 미끄러지고 들리지 않는다, 동심 핀은 축 둘레로만 돈다, 고정 부품은 거부', () => {
    const m = run([{ type: 'add_mate', mate: 'coincident', refs: ['base.top', 'cap.bottom'] }], two);
    const p0 = obj(m, 'cap').transform.position;
    const d = run([{ type: 'move_with_mates', target: 'cap', position: [p0[0] + 30, p0[1] - 10, p0[2] + 50] }], m);
    const p1 = obj(d, 'cap').transform.position;
    expect(p1[0]).toBeCloseTo(p0[0] + 30, 4);
    expect(p1[1]).toBeCloseTo(p0[1] - 10, 4);
    expect(p1[2]).toBeCloseTo(10, 5); // 들어 올린 50 은 메이트가 막는다
    expect(obj(d, 'base').transform).toEqual(obj(m, 'base').transform);
    expect(Math.max(...mateResiduals(d).values())).toBeLessThan(1e-5);

    const pin = run([
      { type: 'create_cylinder', id: 'boss', radius: 6, height: 8 },
      { type: 'create_cylinder', id: 'pin', radius: 3, height: 20, position: [80, 0, 0] },
      { type: 'add_mate', id: 'c1', mate: 'concentric', refs: ['boss.axis', 'pin.axis'] },
      { type: 'add_mate', id: 'd1', mate: 'distance', refs: ['boss.top', 'pin.bottom'], value: 2, flip: false },
    ]);
    const spun = run([{ type: 'move_with_mates', target: 'pin', position: [15, 5, 30], rotation: [20, 0, 40] }], pin);
    const t = obj(spun, 'pin').transform;
    expect(t.position[0]).toBeCloseTo(0, 4);
    expect(t.position[1]).toBeCloseTo(0, 4);
    expect(t.position[2]).toBeCloseTo(10, 4);
    expect(Math.abs(t.rotation[2])).toBeGreaterThan(20); // 축(Z) 둘레 회전은 남는다
    expect(Math.max(...mateResiduals(spun).values())).toBeLessThan(1e-5);

    const fixed = run([{ type: 'add_mate', mate: 'fix', refs: ['base'] }], m);
    expect(err(fixed, { type: 'move_with_mates', target: 'base', position: [5, 0, 0] })).toMatch(/고정/);
    // 메이트 없는 부품은 그냥 옮겨진다
    expect(obj(run([{ type: 'move_with_mates', target: 'base', position: [5, 0, 0] }], two), 'base').transform.position).toEqual([5, 0, 0]);
  });
});
