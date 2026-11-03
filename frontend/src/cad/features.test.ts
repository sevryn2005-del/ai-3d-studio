import { describe, expect, it } from 'vitest';
import { executeCommand } from './commandExecutor';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { byId, topLevelObjects, validateGraph } from './modelGraph';
import { isSuppressed, patternMatrices } from './features';
import { Vector3 } from 'three';

function build(...cmds: unknown[]): ModelDefinition {
  let m = emptyModel();
  for (const c of cmds) {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.error}`);
    m = r.model;
  }
  return m;
}
const err = (m: ModelDefinition, c: unknown) => {
  const r = executeCommand(m, c);
  return r.ok ? null : r.error;
};
const obj = (m: ModelDefinition, id: string) => m.objects.find((o) => o.id === id)!;
const box = { type: 'create_box', id: 'b', width: 40, depth: 30, height: 20 };

describe('억제·외관', () => {
  it('켜고 끄면 필드가 생겼다 없어진다 (파일이 깔끔하게)', () => {
    let m = build(box, { type: 'set_suppressed', target: 'b', suppressed: true }, { type: 'set_appearance', target: 'b', color: '#e5534b', hidden: true });
    expect(obj(m, 'b')).toMatchObject({ suppressed: true, color: '#e5534b', hidden: true });
    m = build(box);
    const on = build(box, { type: 'set_suppressed', target: 'b', suppressed: true });
    const off = executeCommand(on, { type: 'set_suppressed', target: 'b', suppressed: false });
    expect(off.ok && obj(off.model, 'b')).toEqual(obj(m, 'b'));
    const reset = build(box, { type: 'set_appearance', target: 'b', color: '#e5534b' }, { type: 'set_appearance', target: 'b', color: 'default', hidden: false });
    expect(obj(reset, 'b')).toEqual(obj(m, 'b'));
  });
  it('치수를 바꿔도 억제·색은 유지', () => {
    const m = build(box, { type: 'set_appearance', target: 'b', color: '#57ab5a' }, { type: 'set_params', target: 'b', params: { width: 50 } });
    expect(obj(m, 'b')).toMatchObject({ color: '#57ab5a', params: { width: 50 } });
  });
  it('기준이 억제되면 불리언도 억제, 도구만 억제면 불리언은 남는다', () => {
    const m = build(box, { type: 'create_cylinder', id: 'c', radius: 3, height: 30 }, { type: 'cut', id: 'k', base: 'b', tools: ['c'] });
    const toolOff = build(...[box, { type: 'create_cylinder', id: 'c', radius: 3, height: 30 }, { type: 'cut', id: 'k', base: 'b', tools: ['c'] }, { type: 'set_suppressed', target: 'c', suppressed: true }]);
    expect(isSuppressed(obj(toolOff, 'k'), byId(toolOff))).toBe(false);
    const baseOff = executeCommand(m, { type: 'set_suppressed', target: 'b', suppressed: true });
    expect(baseOff.ok && isSuppressed(obj(baseOff.model, 'k'), byId(baseOff.model))).toBe(true);
  });
  it('잘못된 색 형식은 거부', () => {
    expect(err(build(box), { type: 'set_appearance', target: 'b', color: 'red' })).toMatch(/#rrggbb/);
  });
});

describe('쉘', () => {
  it('두께가 가장 얇은 치수의 절반 이상이면 거부, 0 이면 제거', () => {
    expect(err(build(box), { type: 'shell', target: 'b', thickness: 10 })).toMatch(/10mm 보다 작아야/);
    const m = build(box, { type: 'shell', target: 'b', thickness: 2, open: ['top'] });
    expect(obj(m, 'b')).toMatchObject({ shell: { thickness: 2, open: ['top'] } });
    expect(obj(build(box, { type: 'shell', target: 'b', thickness: 2 }, { type: 'shell', target: 'b', thickness: 0 }), 'b')).not.toHaveProperty('shell');
  });
  it('없는 면·필렛 박스·구는 거부, 치수를 줄여 쉘이 안 들어가면 거부', () => {
    expect(err(build(box), { type: 'shell', target: 'b', thickness: 2, open: ['end'] })).toMatch(/열 수 없는 면/);
    expect(err(build(box, { type: 'fillet', target: 'b', radius: 2 }), { type: 'shell', target: 'b', thickness: 2 })).toMatch(/모서리 처리/);
    expect(err(build({ type: 'create_sphere', id: 's', radius: 5 }), { type: 'shell', target: 's', thickness: 1 })).toMatch(/박스·원통·돌출/);
    const m = build(box, { type: 'shell', target: 'b', thickness: 4 });
    expect(err(m, { type: 'set_params', target: 'b', params: { height: 6 } })).toMatch(/쉘 두께를 먼저/);
    expect(err(m, { type: 'fillet', target: 'b', radius: 1 })).toMatch(/쉘/);
  });
});

describe('패턴·대칭', () => {
  it('원본이 자식이 되고, 지우면 원본은 월드 위치 그대로 남는다', () => {
    const m = build({ ...box, position: [5, 6, 0] }, { type: 'pattern', id: 'p', pattern: { type: 'linear', source: 'b', axis: 'x', count: 3, spacing: 50 } });
    expect(topLevelObjects(m).map((o) => o.id)).toEqual(['p']);
    expect(validateGraph(m)).toEqual([]);
    const r = executeCommand(m, { type: 'delete_object', target: 'p' });
    expect(r.ok && r.model.objects).toEqual([expect.objectContaining({ id: 'b', transform: { position: [5, 6, 0], rotation: [0, 0, 0] } })]);
  });
  it('값 바꾸기: 원본 변경·잘못된 개수·같은 축 두 방향은 거부', () => {
    const m = build(box, { type: 'pattern', id: 'p', pattern: { type: 'linear', source: 'b', axis: 'x', count: 3, spacing: 50 } }, box && { type: 'create_box', id: 'z', width: 1, depth: 1, height: 1 });
    expect(err(m, { type: 'set_pattern', target: 'p', pattern: { type: 'linear', source: 'z', axis: 'x', count: 3, spacing: 50 } })).toMatch(/원본/);
    expect(err(m, { type: 'set_pattern', target: 'p', pattern: { type: 'linear', source: 'b', axis: 'x', count: 1, spacing: 50 } })).toMatch(/2 이상/);
    expect(err(m, { type: 'set_pattern', target: 'p', pattern: { type: 'linear', source: 'b', axis: 'x', count: 3, spacing: 50, axis2: 'x', count2: 2, spacing2: 5 } })).toMatch(/다른 축/);
    expect(err(m, { type: 'set_pattern', target: 'p', pattern: { type: 'linear', source: 'b', axis: 'x', count: 100, spacing: 50, axis2: 'y', count2: 5, spacing2: 50 } })).toMatch(/최대/);
    expect(err(m, { type: 'pattern', pattern: { type: 'mirror', source: 'b', plane: 'XY', offset: 0 } })).toMatch(/이미/);
  });
  it('복제하면 원본도 새 ID 로 복제된다', () => {
    const m = build(box, { type: 'pattern', id: 'p', pattern: { type: 'mirror', source: 'b', plane: 'YZ', offset: 0 } }, { type: 'duplicate_object', target: 'p', newId: 'q' });
    const q = obj(m, 'q');
    expect(q.kind === 'pattern' && q.pattern.source).not.toBe('b');
    expect(validateGraph(m)).toEqual([]);
  });
  it('원형 패턴 360° 는 균등, 부분 각도는 양 끝 포함', () => {
    const full = patternMatrices({ type: 'circular', source: 'b', axis: 'z', count: 4, angle: 360 });
    const part = patternMatrices({ type: 'circular', source: 'b', axis: 'z', count: 3, angle: 90 });
    const at = (ms: typeof full, k: number) => new Vector3(1, 0, 0).applyMatrix4(ms[k]!).toArray().map((v) => Math.round(v * 1e6) / 1e6 + 0);
    expect(at(full, 1)).toEqual([0, 1, 0]);
    expect(at(part, 2)).toEqual([0, 1, 0]);
    const mirror = patternMatrices({ type: 'mirror', source: 'b', plane: 'YZ', offset: 10 });
    expect(new Vector3(5, 1, 2).applyMatrix4(mirror[1]!).toArray()).toEqual([15, 1, 2]);
  });
});

describe('구멍 가공', () => {
  it('윗면 중심에서 아래로: 도구 윗면이 박스 윗면, 빼기 하나에 두 번째 구멍이 도구로 더해진다', () => {
    const m = build(box, { type: 'hole', id: 'h1', target: 'b', face: 'top', at: [0, 0], diameter: 5, depth: 8 });
    const h = obj(m, 'h1');
    expect(h.transform.position).toEqual([0, 0, 12]); // 바닥 = 20 − 8
    const m2 = build(box, { type: 'hole', id: 'h1', target: 'b', face: 'top', at: [0, 0], diameter: 5, depth: 8 }, { type: 'hole', id: 'h2', target: 'cut_1', face: 'top', at: [10, 0], diameter: 5, depth: 8 });
    const cut = obj(m2, 'cut_1');
    expect(cut.kind === 'boolean' && cut.boolean.tools).toEqual(['h1', 'h2']);
    expect(validateGraph(m2)).toEqual([]);
  });
  it('옆면(+X)은 X 방향 안쪽으로', () => {
    const m = build(box, { type: 'hole', id: 'h', target: 'b', face: '+X', at: [0, 0], diameter: 5, depth: 8 });
    expect(obj(m, 'h').transform.position).toEqual([12, 0, 10]);
    expect(obj(m, 'h').transform.rotation[1]).toBeCloseTo(90);
  });
  it('카운터보어 지름이 작거나 둘을 함께 쓰면 거부, 없는 면도 거부', () => {
    const m = build(box);
    expect(err(m, { type: 'hole', target: 'b', face: 'top', at: [0, 0], diameter: 6, depth: 8, cboreDiameter: 5, cboreDepth: 2 })).toMatch(/카운터보어 지름/);
    expect(err(m, { type: 'hole', target: 'b', face: 'top', at: [0, 0], diameter: 6, depth: 8, cboreDiameter: 10, cboreDepth: 2, csinkDiameter: 10 })).toMatch(/함께/);
    expect(err(m, { type: 'hole', target: 'b', face: 'end', at: [0, 0], diameter: 6, depth: 8 })).toMatch(/면이 없습니다/);
  });
});
