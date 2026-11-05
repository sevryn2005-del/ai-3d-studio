/** 고른 면·모서리 → 참조·평면·측정 (형식 v12) */
import { describe, expect, it } from 'vitest';
import { emptyModel, type ModelDefinition } from '../../cad/commandTypes';
import { executeCommand } from '../../cad/commandExecutor';
import type { TopoEdge, TopoFace } from '../engine/types';
import { edgesAt, faceToMateRef, faceToSketchPlane, measureEntities } from './pick';

function run(cmds: unknown[]) {
  let m: ModelDefinition = emptyModel();
  for (const c of cmds) {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(r.error);
    m = r.model;
  }
  return m;
}
const plane = (origin: [number, number, number], dir: [number, number, number]): TopoFace => ({ kind: 'plane', origin, dir, radius: 0, positions: new Float32Array(origin), indices: new Uint32Array() });
const line = (a: number[], b: number[]): TopoEdge => ({ kind: 'line', points: Float32Array.from([...a, ...b]), mid: a.map((v, i) => (v + b[i]!) / 2) as [number, number, number], center: [0, 0, 0], dir: [1, 0, 0], radius: 0, length: Math.hypot(...a.map((v, i) => b[i]! - v)) });

describe('고른 면 → 메이트 참조·스케치 평면', () => {
  const m = run([
    { type: 'create_box', id: 'b', width: 20, depth: 10, height: 6, position: [50, 0, 0] },
    { type: 'set_transform', target: 'b', rotation: [0, 0, 90] },
    { type: 'create_cylinder', id: 'c', radius: 3, height: 9, position: [0, 30, 0] },
  ]);
  it('이름 있는 면이면 이름 참조 (월드에서 고른 면을 부품 로컬로 되돌려 비교)', () => {
    expect(faceToMateRef(m, 'b', plane([50, 0, 6], [0, 0, 1]))).toBe('b.top');
    // 90° 돌린 상자의 +X 면은 월드 +Y 쪽 (폭 20 의 절반)
    expect(faceToMateRef(m, 'b', plane([50, 10, 3], [0, 1, 0]))).toBe('b.+X');
    expect(faceToMateRef(m, 'c', { kind: 'cylinder', origin: [0, 30, 0], dir: [0, 0, 1], radius: 3, positions: new Float32Array(), indices: new Uint32Array() })).toBe('c.axis');
  });
  it('이름 없는 면은 고른 기하(부품 로컬)로', () => {
    const r = faceToMateRef(m, 'b', plane([50, 0, 3], [0, 0, 1])); // 상자 안쪽 높이 (이름 있는 면 아님)
    expect(r).toEqual({ object: 'b', kind: 'face', origin: [0, 0, 3], dir: [0, 0, 1] });
  });
  it('스케치 평면: 이름 있는 면 = face, 아니면 frame', () => {
    expect(faceToSketchPlane(m, 'b', plane([50, 0, 6], [0, 0, 1]))).toEqual({ type: 'face', object: 'b', face: 'top', offset: 0 });
    expect(faceToSketchPlane(m, 'b', plane([50, 0, 3], [0, 0, 1]))).toMatchObject({ type: 'frame', origin: [50, 0, 3], normal: [0, 0, 1], xDir: [1, 0, 0] });
  });
});

describe('측정', () => {
  it('평행한 두 평면 사이 거리·각도, 모서리 길이·지름', () => {
    const a = { objectId: 'x', kind: 'face' as const, index: 0, face: plane([0, 0, 0], [0, 0, 1]) };
    const b = { objectId: 'y', kind: 'face' as const, index: 0, face: plane([5, 5, 12.5], [0, 0, -1]) };
    expect(measureEntities([a, b])).toEqual([{ label: '각도', value: 0, unit: '°' }, { label: '평면 사이 거리', value: 12.5, unit: 'mm' }]);
    const e = { objectId: 'x', kind: 'edge' as const, index: 0, edge: line([0, 0, 0], [3, 4, 0]) };
    expect(measureEntities([e])).toEqual([{ label: '모서리 길이', value: 5, unit: 'mm' }]);
    const circle: TopoEdge = { kind: 'circle', points: new Float32Array(), mid: [0, 0, 0], center: [0, 0, 0], dir: [0, 0, 1], radius: 2, length: 4 * Math.PI };
    expect(measureEntities([{ objectId: 'x', kind: 'edge', index: 1, edge: circle }])[0]).toMatchObject({ label: '지름', value: 4 });
  });
  it('수직인 면과 모서리 사이 각도 90°', () => {
    const a = { objectId: 'x', kind: 'face' as const, index: 0, face: plane([0, 0, 0], [0, 0, 1]) };
    const e = { objectId: 'x', kind: 'edge' as const, index: 0, edge: line([0, 0, 0], [10, 0, 0]) };
    expect(measureEntities([a, e]).find((l) => l.label === '각도')!.value).toBeCloseTo(90, 9);
  });
});

describe('필렛 편집: 고른 점 → 모서리 번호', () => {
  it('점이 꺾은선 위에 있는 모서리만', () => {
    const edges = [line([0, 0, 0], [10, 0, 0]), line([0, 0, 0], [0, 10, 0]), line([0, 0, 5], [10, 0, 5])];
    expect(edgesAt(edges, [[5, 0, 0], [10, 0, 5]])).toEqual([0, 2]);
  });
});
