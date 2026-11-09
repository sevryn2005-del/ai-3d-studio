import { describe, expect, it } from 'vitest';
import { executeBatch as executeCommands } from './commandExecutor';
import { createDefaultModel } from './defaultModel';
import { alignPatternToAxisCommands, normalizeReference, planeOfReference, referenceFromPoints } from './references';
import { patternMatrices } from './features';
import { toMatrix } from './transformMath';
import { Vector3 } from 'three';
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

describe('기준 축 둘레 원형 패턴', () => {
  const copies = (m: ModelDefinition) => {
    const pat = m.objects.find((o) => o.kind === 'pattern') as Extract<ModelDefinition['objects'][number], { kind: 'pattern' }>;
    const src = m.objects.find((o) => o.id === pat.pattern.source)!;
    return patternMatrices(pat.pattern).map((r) => {
      const w = toMatrix(pat.transform).multiply(r).multiply(toMatrix(src.transform));
      return new Vector3().setFromMatrixPosition(w).toArray().map((v) => Math.round(v * 1e4) / 1e4 + 0);
    });
  };
  it('축 (10,0,0)+Z 둘레로 4개: 원본은 그대로, 사본은 반지름 20 원 위', () => {
    const r = executeCommands(createDefaultModel(), [
      { type: 'set_transform', target: 'box_1', position: [30, 0, 0] },
      { type: 'pattern', pattern: { type: 'circular', source: 'box_1', axis: 'x', count: 4, angle: 360 } },
      { type: 'add_reference', reference: { type: 'axis', origin: [10, 0, 0], direction: [0, 0, 1] } },
    ]) as { ok: true; model: ModelDefinition };
    expect(r.ok).toBe(true);
    const pat = r.model.objects.find((o) => o.kind === 'pattern')!;
    const cmds = alignPatternToAxisCommands(pat as never, r.model.objects.find((o) => o.id === 'box_1')!, r.model.references![0] as never);
    const r2 = executeCommands(r.model, cmds) as { ok: true; model: ModelDefinition };
    expect(r2.ok).toBe(true);
    expect(copies(r2.model)).toEqual([
      [30, 0, 0],
      [10, 20, 0],
      [-10, 0, 0],
      [10, -20, 0],
    ]);
  });
  it('기울어진 축 (원점 지남, +X 방향) 둘레로 2개: 반대편으로', () => {
    const r = executeCommands(createDefaultModel(), [
      { type: 'set_transform', target: 'box_1', position: [5, 0, 15] },
      { type: 'pattern', pattern: { type: 'circular', source: 'box_1', axis: 'z', count: 2, angle: 360 } },
      { type: 'add_reference', reference: { type: 'axis', origin: [0, 0, 0], direction: [3, 0, 0] } },
    ]) as { ok: true; model: ModelDefinition };
    const pat = r.model.objects.find((o) => o.kind === 'pattern')!;
    const r2 = executeCommands(r.model, alignPatternToAxisCommands(pat as never, r.model.objects.find((o) => o.id === 'box_1')!, r.model.references![0] as never)) as { ok: true; model: ModelDefinition };
    expect(copies(r2.model)).toEqual([
      [5, 0, 15],
      [5, 0, -15],
    ]);
  });
});

describe('곡선 따라 패턴 행렬 (서버 features.py curve_matrices 와 같은 값)', () => {
  it('ㄱ 자 선 3개: 시작 → 꺾인 점 → 끝, align 이면 끝에서 90° 돌림', async () => {
    const { curveMatrices } = await import('./features');
    const { Matrix4: M } = await import('three');
    const pts: [number, number][] = [[0, 0], [40, 0], [40, 40]];
    const at = (m: InstanceType<typeof M>, x: number, y: number) => new Vector3(x, y, 0).applyMatrix4(m).toArray().map((v) => Math.round(v * 1e9) / 1e9 + 0);
    const plain = curveMatrices(pts, new M(), 3, false);
    expect(plain.map((m) => at(m, 1, 0))).toEqual([[1, 0, 0], [41, 0, 0], [41, 40, 0]]);
    const aligned = curveMatrices(pts, new M(), 3, true);
    expect(aligned.map((m) => at(m, 1, 0))).toEqual([[1, 0, 0], [41, 0, 0], [40, 41, 0]]);
  });
});

describe('스케치 위치 패턴 (형식 v36)', () => {
  it('원 중심마다 첫 원 기준으로 옮김, 원이 하나면 거부, 패턴이 쓰는 원은 지울 수 없음', async () => {
    const { patternMatrices, patternError } = await import('./features');
    const { sketchIndex } = await import('./modelGraph');
    const r = executeCommands(createDefaultModel(), [
      { type: 'create_sketch', id: 'ps', plane: { type: 'XY', offset: 5 } },
      { type: 'add_circle', sketch: 'ps', id: 'c1', center: [0, 0], diameter: 2 },
    ]) as { ok: true; model: ModelDefinition };
    const p = { type: 'sketch', source: 'box_1', sketch: 'ps' } as const;
    expect(patternError(p, sketchIndex(r.model))).toContain('원이 2개 이상');
    const r2 = executeCommands(r.model, [
      { type: 'add_circle', sketch: 'ps', id: 'c2', center: [30, 0], diameter: 2 },
      { type: 'add_circle', sketch: 'ps', id: 'c3', center: [0, -20], diameter: 2 },
      { type: 'pattern', id: 'sp', pattern: p },
    ]) as { ok: true; model: ModelDefinition };
    expect(r2.ok).toBe(true);
    const moves = patternMatrices(p, sketchIndex(r2.model)).map((m) => new Vector3().setFromMatrixPosition(m).toArray());
    expect(moves).toEqual([[0, 0, 0], [30, 0, 0], [0, -20, 0]]);
    const del = executeCommands(r2.model, [{ type: 'delete_sketch_entity', sketch: 'ps', entity: 'c2' }]);
    expect(del.ok).toBe(false);
  });
});
