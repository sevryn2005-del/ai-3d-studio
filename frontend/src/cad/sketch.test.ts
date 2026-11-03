import { describe, expect, it } from 'vitest';
import { executeBatch, executeCommand, findObject } from './commandExecutor';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { validateGraph } from './modelGraph';
import { localSize, sizeSummary } from './objectKinds';
import { describeCommand } from './describeCommand';
import { resolveProfile } from './sketch';

const PLATE = [
  { type: 'create_sketch', id: 'sk1', name: '판 윤곽' },
  { type: 'add_rectangle', sketch: 'sk1', id: 'r1', width: 60, height: 40 },
  { type: 'extrude', id: 'plate', name: '판', sketch: 'sk1', profile: 'r1', distance: 4 },
];

function run(m: ModelDefinition, ...cmds: unknown[]): ModelDefinition {
  const r = executeBatch(m, cmds);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

describe('치수형 사각형 → 4 mm 돌출 → 폭 수정', () => {
  it('스케치·치수·돌출이 만들어진다', () => {
    const m = run(emptyModel(), ...PLATE);
    expect(m.sketches).toEqual([{
      id: 'sk1', name: '판 윤곽', plane: { type: 'XY', offset: 0 },
      entities: [{ id: 'r1', type: 'rectangle', center: [0, 0] }],
      dimensions: [
        { id: 'r1.width', entity: 'r1', kind: 'width', value: 60 },
        { id: 'r1.height', entity: 'r1', kind: 'height', value: 40 },
      ],
    }]);
    expect(findObject(m, 'plate')).toMatchObject({ kind: 'extrude', params: { distance: 4 }, extrude: { sketch: 'sk1', profile: 'r1' } });
    expect(sizeSummary(findObject(m, 'plate')!, m)).toBe('60×40×4');
    expect(localSize(findObject(m, 'plate')!, m)).toEqual([60, 40, 4]);
    expect(validateGraph(m)).toEqual([]);
  });

  it('원본 폭만 수정 → 같은 돌출 객체, 형상 키가 바뀌어 재계산', () => {
    const m1 = run(emptyModel(), ...PLATE);
    const m2 = run(m1, { type: 'set_dimension', sketch: 'sk1', dimension: 'r1.width', value: 80 });
    expect(findObject(m2, 'plate')).toEqual(findObject(m1, 'plate')); // 객체 자체는 그대로 (파라메트릭)
    expect(sizeSummary(findObject(m2, 'plate')!, m2)).toBe('80×40×4'); // 형상 키 변화는 renderMesh.test.ts
  });

  it('두께는 set_params(distance), 원 프로파일, 평면 높이', () => {
    let m = run(emptyModel(), ...PLATE, { type: 'set_params', target: 'plate', params: { distance: 6 } });
    expect(sizeSummary(findObject(m, 'plate')!, m)).toBe('60×40×6');
    m = run(m,
      { type: 'create_sketch', id: 'sk2', plane: { type: 'XY', offset: -1 } },
      { type: 'add_circle', sketch: 'sk2', id: 'c1', center: [18, 0], diameter: 6 },
      { type: 'extrude', id: 'hole', sketch: 'sk2', profile: 'c1', distance: 8 },
    );
    expect(resolveProfile(m.sketches[1]!, 'c1')).toEqual({ type: 'circle', center: [18, 0], diameter: 6, z: -1, plane: { type: 'XY', offset: -1 } });
    expect(sizeSummary(findObject(m, 'hole')!, m)).toBe('Ø6×8');
  });

  it('관통 구멍: 원 돌출을 판에서 빼고, 이후에도 판 폭을 수정할 수 있다', () => {
    let m = run(emptyModel(), ...PLATE,
      { type: 'create_sketch', id: 'sk2', plane: { type: 'XY', offset: -1 } },
      { type: 'add_circle', sketch: 'sk2', id: 'c1', center: [18, 0], diameter: 6 },
      { type: 'extrude', id: 'hole', sketch: 'sk2', profile: 'c1', distance: 6 },
      { type: 'cut', id: 'plate_holed', base: 'plate', tools: ['hole'] },
    );
    m = run(m, { type: 'set_dimension', sketch: 'sk1', dimension: 'r1.width', value: 80 });
    expect(sizeSummary(findObject(m, 'plate')!, m)).toBe('80×40×4');
    expect(validateGraph(m)).toEqual([]);
  });
});

describe('거부되는 경우 (원본 보존)', () => {
  const base = run(emptyModel(), ...PLATE);
  it.each([
    [{ type: 'add_rectangle', sketch: 'nope', width: 1, height: 1 }, '존재하지 않는 스케치'],
    [{ type: 'set_dimension', sketch: 'sk1', dimension: 'r1.diameter', value: 5 }, '치수 r1.diameter 이(가) 없습니다 (있는 치수: r1.width, r1.height)'],
    [{ type: 'set_dimension', sketch: 'sk1', dimension: 'r1.width', value: 0 }, '0.1mm 이상'],
    [{ type: 'extrude', sketch: 'sk1', profile: 'zz', distance: 4 }, '프로파일 zz 이(가) 없습니다'],
    [{ type: 'extrude', sketch: 'sk1', profile: 'r1', distance: 0.05 }, '잘못된 명령'], // |거리| < 0.1 (음수는 반대 방향으로 유효)
    [{ type: 'create_sketch', id: 'plate' }, '이미 존재하는 ID'],
    [{ type: 'create_box', id: 'sk1', width: 1, depth: 1, height: 1 }, '이미 존재하는 ID'],
    [{ type: 'add_rectangle', sketch: 'sk1', id: 'r1', width: 1, height: 1 }, '이미 있는 요소 ID'],
  ])('%j', (cmd, msg) => {
    const r = executeCommand(base, cmd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });
});

describe('validateGraph: 불러온 파일의 스케치 규칙', () => {
  const base = run(emptyModel(), ...PLATE);
  const withSketch = (patch: object) => ({ ...base, sketches: [{ ...base.sketches[0]!, ...patch }] }) as ModelDefinition;

  it('치수 누락', () => {
    expect(validateGraph(withSketch({ dimensions: base.sketches[0]!.dimensions.slice(0, 1) }))).toContain('sk1: r1 의 height 치수가 없습니다');
  });
  it('사각형에 지름 치수', () => {
    const dims = [...base.sketches[0]!.dimensions, { id: 'r1.diameter', entity: 'r1', kind: 'diameter', value: 3 }];
    expect(validateGraph(withSketch({ dimensions: dims })).some((e) => e.includes('diameter 치수가 없습니다'))).toBe(true);
  });
  it('돌출이 없는 스케치를 참조', () => {
    const m = { ...base, sketches: [] } as ModelDefinition;
    expect(validateGraph(m)).toContain('plate: 존재하지 않는 스케치를 참조합니다: sk1');
  });
});

it('설명 문구', () => {
  const m = run(emptyModel(), ...PLATE);
  expect(describeCommand({ type: 'set_dimension', sketch: 'sk1', dimension: 'r1.width', value: 80 }, m)).toBe('판 윤곽 치수 r1.width → 80mm');
  expect(describeCommand({ type: 'extrude', sketch: 'sk1', profile: 'r1', distance: 4 }, m)).toBe('판 윤곽의 r1 을(를) 4mm 돌출');
});

describe('스케치 관리 (이름·삭제·요소 이동/삭제)', () => {
  const base = run(emptyModel(), ...PLATE, { type: 'add_circle', sketch: 'sk1', id: 'c1', center: [5, 0], diameter: 3 });

  it('요소 중심 이동 → 돌출 단면이 따라온다', () => {
    const m = run(base, { type: 'set_entity_center', sketch: 'sk1', entity: 'r1', center: [10, -5] });
    expect(resolveProfile(m.sketches[0]!, 'r1')).toMatchObject({ center: [10, -5], width: 60 });
  });

  it('쓰이지 않는 요소는 치수와 함께 삭제', () => {
    const m = run(base, { type: 'delete_sketch_entity', sketch: 'sk1', entity: 'c1' });
    expect(m.sketches[0]!.entities.map((e) => e.id)).toEqual(['r1']);
    expect(m.sketches[0]!.dimensions.map((d) => d.id)).toEqual(['r1.width', 'r1.height']);
    expect(validateGraph(m)).toEqual([]);
  });

  it('돌출이 쓰는 요소·스케치는 삭제 거부, 돌출을 지운 뒤에는 삭제', () => {
    for (const cmd of [
      { type: 'delete_sketch_entity', sketch: 'sk1', entity: 'r1' },
      { type: 'delete_sketch', sketch: 'sk1' },
    ]) {
      const r = executeCommand(base, cmd);
      expect(!r.ok && r.error).toContain('쓰는 돌출이 있어 삭제할 수 없습니다: 판');
    }
    const m = run(base, { type: 'delete_object', target: 'plate' }, { type: 'delete_sketch', sketch: 'sk1' });
    expect(m.sketches).toEqual([]);
  });

  it('이름 변경', () => {
    const m = run(base, { type: 'rename_sketch', sketch: 'sk1', name: '  뚜껑  ' });
    expect(m.sketches[0]!.name).toBe('뚜껑');
  });

  it('없는 요소', () => {
    const r = executeCommand(base, { type: 'set_entity_center', sketch: 'sk1', entity: 'zz', center: [0, 0] });
    expect(!r.ok && r.error).toContain('요소 zz 이(가) 없습니다 (있는 요소: r1, c1)');
  });
});
