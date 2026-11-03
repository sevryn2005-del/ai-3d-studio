import { describe, expect, it } from 'vitest';
import { executeBatch, findObject } from './commandExecutor';
import { emptyModel, type CadCommand, type ModelDefinition } from './commandTypes';
import { validateGraph } from './modelGraph';
import { rectangleSketchCommands, throughHoleCommands } from './sketchActions';

function run(m: ModelDefinition, cmds: unknown[]): ModelDefinition {
  const r = executeBatch(m, cmds);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

function plateModel(position: [number, number, number] = [0, 0, 0], rotation: [number, number, number] = [0, 0, 0]) {
  const { sketchId, commands } = rectangleSketchCommands(emptyModel());
  const cmds: unknown[] = [...commands, { type: 'extrude', id: 'plate', sketch: sketchId, profile: 'r1', distance: 4, position }];
  if (rotation.some((v) => v !== 0)) cmds.push({ type: 'set_transform', target: 'plate', rotation });
  return run(emptyModel(), cmds);
}

function holeCmds(m: ModelDefinition, plateId: string, center: [number, number], diameter = 6): CadCommand[] {
  const r = throughHoleCommands(m, plateId, { center, diameter });
  if (!r.ok) throw new Error(r.error);
  return r.commands;
}

describe('rectangleSketchCommands', () => {
  it('스케치 + 사각형 60×40, ID 는 기존과 겹치지 않는다', () => {
    const m = run(emptyModel(), rectangleSketchCommands(emptyModel()).commands);
    expect(m.sketches.map((s) => s.id)).toEqual(['sketch_1']);
    expect(m.sketches[0]!.dimensions.map((d) => [d.id, d.value])).toEqual([['r1.width', 60], ['r1.height', 40]]);
    expect(rectangleSketchCommands(m).sketchId).toBe('sketch_2');
  });
});

describe('throughHoleCommands', () => {
  it('판 아래 1mm 에서 두께+2mm 돌출 후 판에서 뺀다', () => {
    const m0 = plateModel([10, 5, 0]);
    const m = run(m0, holeCmds(m0, 'plate', [18, 0]));
    expect(validateGraph(m)).toEqual([]);
    const hole = findObject(m, 'hole_1')!;
    expect(hole.kind === 'extrude' && hole.params.distance).toBe(6);
    expect(m.sketches.find((s) => s.id === 'sk_hole_1')!.plane.offset).toBe(-1);
    const cut = findObject(m, 'cut_1')!;
    expect(cut.kind === 'boolean' && cut.boolean).toEqual({ operation: 'cut', base: 'plate', tools: ['hole_1'] });
    expect(cut.transform.position).toEqual([10, 5, 0]);
    // 구멍은 판과 같은 좌표계 → 불리언 기준 상대 변환은 항등
    expect(hole.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] });
  });

  it('회전된 판도 같은 좌표계로 맞춘다', () => {
    const m0 = plateModel([0, 0, 0], [0, 0, 30]);
    const cmds = holeCmds(m0, 'plate', [0, 0]);
    expect(cmds.map((c) => c.type)).toEqual(['create_sketch', 'add_circle', 'extrude', 'set_transform', 'cut']);
    const m = run(m0, cmds);
    expect(findObject(m, 'hole_1')!.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 0] });
  });

  it('이미 구멍 뚫린 판에 두 번째 구멍: 최상위 불리언에서 뺀다', () => {
    const m0 = plateModel([10, 0, 0]);
    const m1 = run(m0, holeCmds(m0, 'plate', [18, 0]));
    const m2 = run(m1, holeCmds(m1, 'plate', [-18, 0]));
    expect(validateGraph(m2)).toEqual([]);
    const cut2 = findObject(m2, 'cut_2')!;
    expect(cut2.kind === 'boolean' && cut2.boolean.base).toBe('cut_1');
    expect(findObject(m2, 'hole_2')!.transform.position).toEqual([0, 0, 0]);
  });

  it('가장자리를 넘거나 너무 가까운 구멍은 만들지 않는다', () => {
    const m = plateModel();
    expect(throughHoleCommands(m, 'plate', { center: [28, 0], diameter: 6 })).toMatchObject({ ok: false });
    expect(throughHoleCommands(m, 'plate', { center: [0, 0], diameter: 39.5 })).toMatchObject({ ok: false });
    expect(throughHoleCommands(m, 'plate', { center: [0, 0], diameter: 39 })).toMatchObject({ ok: true });
  });

  it('돌출이 아닌 객체는 거부', () => {
    const m = run(emptyModel(), [{ type: 'create_box', id: 'b', width: 10, depth: 10, height: 10 }]);
    expect(throughHoleCommands(m, 'b', { center: [0, 0], diameter: 2 })).toEqual({ ok: false, error: '돌출 객체에만 구멍을 낼 수 있습니다' });
  });
});
