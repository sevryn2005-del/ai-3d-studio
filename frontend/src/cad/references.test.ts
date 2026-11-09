import { describe, expect, it } from 'vitest';
import { executeBatch as executeCommands } from './commandExecutor';
import { createDefaultModel } from './defaultModel';
import { normalizeReference, planeOfReference, referenceFromPoints } from './references';
import type { ModelDefinition, Reference } from './commandTypes';

describe('참조 형상 (형식 v34)', () => {
  it('세 점 → 평면: 법선 = (b−a)×(c−a), x = b−a (단위로)', () => {
    const body = referenceFromPoints('plane', [[0, 0, 10], [10, 0, 10], [0, 5, 10]]);
    expect(body).toEqual({ type: 'plane', origin: [0, 0, 10], normal: [0, 0, 50], xDir: [10, 0, 0] });
    const r = normalizeReference({ ...(body as { type: 'plane' }), id: 'p', name: 'P' }) as Reference & { type: 'plane' };
    expect(r.normal).toEqual([0, 0, 1]);
    expect(r.xDir).toEqual([1, 0, 0]);
    expect(planeOfReference(r)).toEqual({ type: 'frame', origin: [0, 0, 10], normal: [0, 0, 1], xDir: [1, 0, 0], offset: 0 });
    expect(referenceFromPoints('plane', [[0, 0, 0], [1, 0, 0], [2, 0, 0]])).toBe('세 점이 한 줄 위에 있습니다');
    expect(referenceFromPoints('axis', [[1, 1, 1], [1, 1, 1]])).toBe('두 점이 같습니다');
    expect(referenceFromPoints('csys', [[0, 0, 0]])).toBe('점을 3개 고르세요');
  });
  it('좌표계: x 를 z 에 수직으로 고친다', () => {
    const r = normalizeReference({ id: 'c', name: 'C', type: 'csys', origin: [0, 0, 0], xDir: [1, 0, 1], zDir: [0, 0, 2] });
    expect(r).toMatchObject({ xDir: [1, 0, 0], zDir: [0, 0, 1] });
    expect(normalizeReference({ id: 'c', name: 'C', type: 'csys', origin: [0, 0, 0], xDir: [0, 0, 3], zDir: [0, 0, 2] })).toBe('좌표계 x 방향이 z 와 나란합니다');
  });
  it('명령: 추가(자동 ID·이름) → 이름 바꾸기 → 삭제, 형상은 그대로', () => {
    const m0 = createDefaultModel();
    const r1 = executeCommands(m0, [
      { type: 'add_reference', reference: { type: 'axis', origin: [0, 0, 0], direction: [0, 0, 5] } },
      { type: 'add_reference', reference: { type: 'point', position: [1, 2, 3], name: '구멍 중심' } },
    ]);
    expect(r1.ok).toBe(true);
    const m1 = (r1 as { model: ModelDefinition }).model;
    expect(m1.references).toEqual([
      { id: 'ref_axis_1', name: '기준 축 1', type: 'axis', origin: [0, 0, 0], direction: [0, 0, 1] },
      { id: 'ref_point_1', name: '구멍 중심', type: 'point', position: [1, 2, 3] },
    ]);
    expect(m1.objects).toEqual(m0.objects);
    const r2 = executeCommands(m1, [{ type: 'rename_reference', target: 'ref_axis_1', name: '회전 축' }, { type: 'delete_reference', target: 'ref_point_1' }]);
    expect((r2 as { model: ModelDefinition }).model.references).toEqual([{ id: 'ref_axis_1', name: '회전 축', type: 'axis', origin: [0, 0, 0], direction: [0, 0, 1] }]);
    const r3 = executeCommands(m1, [{ type: 'delete_reference', target: 'ref_axis_1' }, { type: 'delete_reference', target: 'ref_point_1' }]);
    expect('references' in (r3 as { model: ModelDefinition }).model).toBe(false);
    expect(executeCommands(m1, [{ type: 'add_reference', reference: { type: 'point', id: 'box_1', position: [0, 0, 0] } }]).ok).toBe(false);
    expect(executeCommands(m1, [{ type: 'delete_reference', target: 'nope' }]).ok).toBe(false);
  });
});
