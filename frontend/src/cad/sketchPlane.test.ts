import { describe, expect, it } from 'vitest';
import { Box3, BoxGeometry, CylinderGeometry, Mesh, Vector3, type Matrix4 } from 'three';
import { emptyModel, type ModelDefinition, type StandardPlane } from './commandTypes';
import { executeBatch, executeCommand, findObject } from './commandExecutor';
import { validateGraph } from './modelGraph';
import { localSize } from './objectKinds';
import type { Profile } from './sketch';
import {
  extrudeLocalMatrix,
  extrudeLocalSize,
  extrudePreviewMatrix,
  faceLocalMatrix,
  facesOf,
  planeMatrix,
  sketchWorldMatrix,
} from './sketchPlane';

const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
const box = (mesh: Mesh) => {
  mesh.updateMatrixWorld(true);
  const b = new Box3().setFromObject(mesh);
  return [...b.min.toArray(), ...b.max.toArray()].map(round);
};
const origin = (m: Matrix4) => new Vector3().setFromMatrixPosition(m).toArray().map(round);
const normal = (m: Matrix4) => new Vector3(0, 0, 1).transformDirection(m).toArray().map(round);

function run(m: ModelDefinition, cmds: unknown[]): ModelDefinition {
  const r = executeBatch(m, cmds);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

/** 판 80×40×4 (XY 스케치) 을 (10, 0, 0) 에 놓고 Z 90° 회전 */
function plate(distance = 4): ModelDefinition {
  return run(emptyModel(), [
    { type: 'create_sketch', id: 'sk_plate' },
    { type: 'add_rectangle', sketch: 'sk_plate', id: 'r1', width: 80, height: 40 },
    { type: 'extrude', id: 'plate', sketch: 'sk_plate', profile: 'r1', distance, position: [10, 0, 0] },
    { type: 'set_transform', target: 'plate', rotation: [0, 0, 90] },
  ]);
}

describe('기준 평면 (서버 test_sketch_extrude.py 와 같은 기대값)', () => {
  it('평면 원점 = 법선 × offset, 기저는 회전(뒤집힘 없음)', () => {
    for (const [type, o] of [['XY', [0, 0, 3]], ['XZ', [0, -3, 0]], ['YZ', [3, 0, 0]]] as const) {
      const m = planeMatrix({ type, offset: 3 });
      expect(origin(m)).toEqual(o);
      expect(m.determinant()).toBeCloseTo(1, 12);
    }
  });

  it.each([
    ['XZ 사각형', { type: 'rectangle', center: [5, 10], width: 30, height: 20 }, { type: 'XZ', offset: 3 }, 4, [-10, -7, 0, 20, -3, 20]],
    ['YZ 원', { type: 'circle', center: [2, 8], diameter: 10 }, { type: 'YZ', offset: -2 }, 6, [-2, -3, 3, 4, 7, 13]],
    ['XY 원', { type: 'circle', center: [18, 0], diameter: 6 }, { type: 'XY', offset: -1 }, 6, [15, -3, -1, 21, 3, 5]],
    ['XY 사각형, 반대 방향(−4)', { type: 'rectangle', center: [0, 0], width: 10, height: 6 }, { type: 'XY', offset: 0 }, -4, [-5, -3, -4, 5, 3, 0]],
  ] as const)('미리보기 배치: %s', (_, profile, plane, distance, expected) => {
    const p = { ...profile, z: plane.offset, plane } as unknown as Profile;
    const d = Math.abs(distance);
    const r = p as Extract<Profile, { type: 'rectangle' }>;
    const geom = p.type === 'circle' ? new CylinderGeometry(p.diameter / 2, p.diameter / 2, d, 64) : new BoxGeometry(r.width, r.height, d);
    const mesh = new Mesh(geom);
    mesh.applyMatrix4(extrudePreviewMatrix(p, distance, planeMatrix(plane as StandardPlane)));
    box(mesh).forEach((v, i) => expect(v).toBeCloseTo(expected[i]!, 1)); // 원통 다각형 근사 허용
  });

  it('평면 크기 → 로컬 X·Y·Z', () => {
    const size = (type: StandardPlane['type']) => extrudeLocalSize(planeMatrix({ type, offset: 0 }), [30, 20, 4]);
    expect(size('XY')).toEqual([30, 20, 4]);
    expect(size('XZ')).toEqual([30, 4, 20]);
    expect(size('YZ')).toEqual([4, 30, 20]);
  });
});

describe('이름 있는 면 (docs/design-face-sketch.md 4.1 표)', () => {
  const m = run(emptyModel(), [
    { type: 'create_box', id: 'b', width: 30, depth: 20, height: 10 },
    { type: 'create_cylinder', id: 'c', radius: 5, height: 12 },
    { type: 'create_sphere', id: 's', radius: 5 },
  ]);
  const face = (id: string, f: Parameters<typeof faceLocalMatrix>[2]) => faceLocalMatrix(m, findObject(m, id)!, f)!;

  it('박스 6면: 원점 = 면 중심, z = 바깥 법선, 기저는 회전', () => {
    const table = {
      top: [[0, 0, 10], [0, 0, 1]],
      bottom: [[0, 0, 0], [0, 0, -1]],
      '+X': [[15, 0, 5], [1, 0, 0]],
      '-X': [[-15, 0, 5], [-1, 0, 0]],
      '+Y': [[0, 10, 5], [0, 1, 0]],
      '-Y': [[0, -10, 5], [0, -1, 0]],
    } as const;
    for (const [f, [o, n]] of Object.entries(table)) {
      const fm = face('b', f as keyof typeof table);
      expect([f, origin(fm), normal(fm)]).toEqual([f, o, n]);
      expect(fm.determinant()).toBeCloseTo(1, 12);
    }
    // 옆면의 v 축은 위(+Z)를 향한다 → 옆면 스케치의 "높이"가 위쪽
    for (const f of ['+X', '-X', '+Y', '-Y'] as const) expect(new Vector3(0, 1, 0).transformDirection(face('b', f)).z).toBeCloseTo(1, 12);
  });

  it('종류별 면 목록', () => {
    expect(facesOf(m, findObject(m, 'c')!)).toEqual(['top', 'bottom']);
    expect(facesOf(m, findObject(m, 's')!)).toEqual([]);
    expect(origin(face('c', 'top'))).toEqual([0, 0, 12]);
    const p = plate();
    expect(facesOf(p, findObject(p, 'plate')!)).toEqual(['end', 'start', '+u', '-u', '+v', '-v']);
  });
});

describe('면 위 스케치: 붙은 객체를 따라간다', () => {
  /** 판 윗면(end)에 원 Ø10 → 6mm 기둥 */
  const withBoss = (m: ModelDefinition) =>
    run(m, [
      { type: 'create_sketch', id: 'sk_boss', plane: { type: 'face', object: 'plate', face: 'end', offset: 0 } },
      { type: 'add_circle', sketch: 'sk_boss', id: 'c1', center: [5, 0], diameter: 10 },
      { type: 'extrude', id: 'boss', sketch: 'sk_boss', profile: 'c1', distance: 6 },
    ]);
  const bossWorld = (m: ModelDefinition) => {
    const boss = findObject(m, 'boss');
    if (boss?.kind !== 'extrude') throw new Error('boss');
    // 기둥 축 위 두 점(바닥 중심·위 중심)의 월드 좌표
    const sk = m.sketches.find((s) => s.id === 'sk_boss')!;
    const w = sketchWorldMatrix(m, sk)!;
    return [new Vector3(5, 0, 0).applyMatrix4(w).toArray().map(round), new Vector3(5, 0, 6).applyMatrix4(w).toArray().map(round)];
  };

  it('판(10,0,0)·Z90° 의 윗면 위: 스케치 (5,0) → 월드 (10,5,4)', () => {
    const m = withBoss(plate());
    expect(validateGraph(m)).toEqual([]);
    expect(bossWorld(m)).toEqual([[10, 5, 4], [10, 5, 10]]);
    // 돌출 객체 로컬 = 월드 (boss 는 원점·무회전) → 로컬 크기는 Ø10 × 6 (Z)
    expect(localSize(findObject(m, 'boss')!, m)).toEqual([10, 10, 6]);
  });

  it('판 두께 4 → 6: 기둥이 따라 올라간다 (면 번호가 아니라 이름으로 참조)', () => {
    const m = run(withBoss(plate()), [{ type: 'set_params', target: 'plate', params: { distance: 6 } }]);
    expect(bossWorld(m)).toEqual([[10, 5, 6], [10, 5, 12]]);
  });

  it('판을 옮기면 기둥도 옮겨진다', () => {
    const m = run(withBoss(plate()), [{ type: 'set_transform', target: 'plate', position: [0, 0, 20] }]);
    expect(bossWorld(m)[0]).toEqual([0, 5, 24]);
  });

  it('판을 불리언(구멍)에 넣어도 같은 면 (불리언 기준 객체로 위임)', () => {
    const m = run(withBoss(plate()), [
      { type: 'create_cylinder', id: 'pin', radius: 2, height: 10, position: [30, 0, -1] },
      { type: 'cut', id: 'holed', base: 'plate', tools: ['pin'] },
    ]);
    expect(validateGraph(m)).toEqual([]);
    expect(bossWorld(m)).toEqual([[10, 5, 4], [10, 5, 10]]);
  });

  it('반대 방향(−3) 돌출은 면 안쪽으로 (구멍·홈)', () => {
    const m = run(plate(), [
      { type: 'create_sketch', id: 'sk_pocket', plane: { type: 'face', object: 'plate', face: 'end', offset: 0 } },
      { type: 'add_rectangle', sketch: 'sk_pocket', id: 'r1', width: 10, height: 6 },
      { type: 'extrude', id: 'pocket', sketch: 'sk_pocket', profile: 'r1', distance: -3 },
    ]);
    const pocket = findObject(m, 'pocket');
    if (pocket?.kind !== 'extrude') throw new Error();
    const local = extrudeLocalMatrix(m, pocket)!;
    // 판 윗면 z=4 에서 아래로 3mm → z 1..4
    expect(new Vector3(0, 0, -3).applyMatrix4(local).z).toBeCloseTo(1, 9);
    expect(localSize(pocket, m)).toEqual([6, 10, 3]); // 판이 Z 90° 회전 → u 축이 월드 Y
  });

  it('스케치를 자신이 만든 형상의 면에 붙이면 순환 → 거부', () => {
    const m = plate();
    const r = executeCommand(m, { type: 'set_sketch_plane', sketch: 'sk_plate', plane: { type: 'face', object: 'plate', face: 'end', offset: 0 } });
    expect(!r.ok && r.error).toContain('면 참조가 순환합니다');
  });

  it('없는 면·없는 객체는 거부', () => {
    const m = run(plate(), [{ type: 'create_sphere', id: 'ball', radius: 3 }]);
    for (const [plane, msg] of [
      [{ type: 'face', object: 'ball', face: 'top', offset: 0 }, "'top' 면이 없습니다 (있는 면: 없음)"],
      [{ type: 'face', object: 'ghost', face: 'top', offset: 0 }, '존재하지 않는 객체'],
    ] as const) {
      const r = executeCommand(m, { type: 'create_sketch', plane });
      expect(!r.ok && r.error).toContain(msg);
    }
  });

  it('스케치가 붙은 객체는 삭제 거부, 스케치를 먼저 지우면 삭제', () => {
    const m = withBoss(plate());
    const r = executeCommand(m, { type: 'delete_object', target: 'plate' });
    expect(!r.ok && r.error).toContain('이 객체의 면에 붙어 있어 삭제할 수 없습니다');
    const cleared = run(m, [{ type: 'delete_object', target: 'boss' }, { type: 'delete_sketch', sketch: 'sk_boss' }, { type: 'delete_object', target: 'plate' }]);
    expect(cleared.objects).toEqual([]);
  });
});
