import { describe, expect, it } from 'vitest';
import { executeCommand, findObject } from './commandExecutor';
import { emptyModel, type ModelDefinition, type Transform } from './commandTypes';
import { childIds, parentMap, topLevelObjects, validateGraph } from './modelGraph';
import { composeTransform, relativeTransform } from './transformMath';

function run(model: ModelDefinition, cmd: unknown): ModelDefinition {
  const r = executeCommand(model, cmd);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

/** 박스(받침) + 원통(구멍) — 박스는 x=50 에 45° 회전, 원통은 박스 위 월드 좌표 (50, 0, -1) */
function plateWithPin(): ModelDefinition {
  let m = run(emptyModel(), { type: 'create_box', id: 'plate', width: 40, depth: 20, height: 5, position: [50, 0, 0] });
  m = run(m, { type: 'set_transform', target: 'plate', rotation: [0, 0, 45] });
  return run(m, { type: 'create_cylinder', id: 'pin', radius: 3, height: 10, position: [50, 0, -1] });
}

const close = (a: Transform, b: Transform) => {
  a.position.forEach((v, i) => expect(v).toBeCloseTo(b.position[i]!, 6));
  a.rotation.forEach((v, i) => expect(v).toBeCloseTo(b.rotation[i]!, 6));
};

describe('transformMath', () => {
  it('relative 후 compose 하면 원래 월드 변환으로 돌아온다', () => {
    const parent: Transform = { position: [10, -5, 3], rotation: [15, -30, 60] };
    const world: Transform = { position: [1, 2, 3], rotation: [0, 45, 10] };
    close(composeTransform(parent, relativeTransform(parent, world)), world);
  });
});

describe('cut / union / intersect', () => {
  it('cut: 불리언 객체를 만들고 피연산자를 자식으로 보존한다', () => {
    const r = executeCommand(plateWithPin(), { type: 'cut', base: 'plate', tools: ['pin'] });
    if (!r.ok) throw new Error(r.error);
    const m = r.model;
    expect(r.affectedId).toBe('cut_1');
    const cut = findObject(m, 'cut_1')!;
    expect(cut).toMatchObject({ kind: 'boolean', name: '빼기 1', boolean: { operation: 'cut', base: 'plate', tools: ['pin'] } });
    expect(topLevelObjects(m).map((o) => o.id)).toEqual(['cut_1']);
    expect(validateGraph(m)).toEqual([]);
  });

  it('불리언 좌표계 = 기준 객체 변환, 자식의 월드 위치는 그대로 유지된다', () => {
    const before = plateWithPin();
    const m = run(before, { type: 'cut', base: 'plate', tools: ['pin'] });
    const cut = findObject(m, 'cut_1')!;
    expect(cut.transform).toEqual({ position: [50, 0, 0], rotation: [0, 0, 45] });
    expect(findObject(m, 'plate')!.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] });
    // 원통: 부모 기준 변환을 합성하면 원래 월드 변환
    close(composeTransform(cut.transform, findObject(m, 'pin')!.transform), findObject(before, 'pin')!.transform);
  });

  it('union 은 도구 여러 개를 받는다', () => {
    let m = plateWithPin();
    m = run(m, { type: 'create_sphere', id: 'knob', radius: 4, position: [50, 0, 5] });
    m = run(m, { type: 'union', base: 'plate', tools: ['pin', 'knob'] });
    expect(childIds(findObject(m, 'union_1')!)).toEqual(['plate', 'pin', 'knob']);
  });

  it.each([
    [{ type: 'cut', base: 'plate', tools: ['nope'] }, '존재하지 않는 객체'],
    [{ type: 'cut', base: 'plate', tools: ['plate'] }, '같은 객체를 두 번'],
    [{ type: 'cut', base: 'plate', tools: [] }, '잘못된 명령'],
  ])('잘못된 불리언 거부: %j', (cmd, msg) => {
    const r = executeCommand(plateWithPin(), cmd);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(msg);
  });

  it('이미 다른 불리언에 포함된 객체는 다시 사용할 수 없다', () => {
    let m = run(plateWithPin(), { type: 'cut', base: 'plate', tools: ['pin'] });
    m = run(m, { type: 'create_box', id: 'other', width: 5, depth: 5, height: 5 });
    const r = executeCommand(m, { type: 'union', base: 'other', tools: ['pin'] });
    expect(r).toEqual({ ok: false, error: "'원통 1'은(는) 이미 다른 불리언에 포함되어 있습니다" });
  });

  it('불리언 결과끼리 다시 연산할 수 있다 (중첩)', () => {
    let m = run(plateWithPin(), { type: 'cut', base: 'plate', tools: ['pin'] });
    m = run(m, { type: 'create_box', id: 'rib', width: 2, depth: 20, height: 10, position: [60, 0, 0] });
    m = run(m, { type: 'union', base: 'cut_1', tools: ['rib'] });
    expect(parentMap(m).get('cut_1')).toBe('union_1');
    expect(validateGraph(m)).toEqual([]);
  });
});

describe('트리 편집 규칙', () => {
  const withCut = () => run(plateWithPin(), { type: 'cut', base: 'plate', tools: ['pin'] });

  it('자식(구멍) 치수 변경은 허용된다 — 파라메트릭', () => {
    const m = run(withCut(), { type: 'set_params', target: 'pin', params: { radius: 5 } });
    expect(findObject(m, 'pin')).toMatchObject({ params: { radius: 5 } });
  });

  it('자식 이동은 부모 좌표계 기준이다', () => {
    const m = withCut();
    const before = findObject(m, 'pin')!.transform.position;
    const moved = run(m, { type: 'translate', target: 'pin', offset: [5, 0, 0] });
    expect(findObject(moved, 'pin')!.transform.position[0]).toBeCloseTo(before[0] + 5, 6);
  });

  it('불리언 결과에는 set_params 를 쓸 수 없다', () => {
    const r = executeCommand(withCut(), { type: 'set_params', target: 'cut_1', params: { height: 5 } });
    expect(r.ok).toBe(false);
  });

  it('자식만 단독 삭제는 거부, 불리언 삭제 시 하위 전체 삭제', () => {
    const m = withCut();
    expect(executeCommand(m, { type: 'delete_object', target: 'pin' }).ok).toBe(false);
    expect(run(m, { type: 'delete_object', target: 'cut_1' }).objects).toEqual([]);
  });

  it('불리언 복제는 하위 객체까지 새 ID 로 복제한다', () => {
    const m = run(withCut(), { type: 'duplicate_object', target: 'cut_1', offset: [0, 40, 0] });
    expect(m.objects.map((o) => o.id)).toEqual(['plate', 'pin', 'cut_1', 'box_1', 'cylinder_1', 'cut_2']);
    expect(findObject(m, 'cut_2')).toMatchObject({ boolean: { base: 'box_1', tools: ['cylinder_1'] } });
    expect(findObject(m, 'cut_2')!.transform.position).toEqual([50, 40, 0]);
    expect(validateGraph(m)).toEqual([]);
  });

  it('자식 복제는 거부한다', () => {
    expect(executeCommand(withCut(), { type: 'duplicate_object', target: 'pin' }).ok).toBe(false);
  });
});

describe('validateGraph (불러온 파일 검증)', () => {
  it('순환, 이중 부모, 없는 참조를 찾는다', () => {
    const m = withCutModel();
    const cut = m.objects.find((o) => o.id === 'cut_1')!;
    if (cut.kind !== 'boolean') throw new Error();
    const bad: ModelDefinition = {
      ...m,
      objects: [
        ...m.objects,
        { ...cut, id: 'cut_2', boolean: { ...cut.boolean, tools: ['ghost'] } },
      ],
    };
    const errors = validateGraph(bad);
    expect(errors.some((e) => e.includes('존재하지 않는 객체'))).toBe(true);
    expect(errors.some((e) => e.includes('두 개 이상의 불리언'))).toBe(true);
  });
});

function withCutModel() {
  return run(plateWithPin(), { type: 'cut', base: 'plate', tools: ['pin'] });
}
