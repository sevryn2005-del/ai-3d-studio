import { describe, expect, it } from 'vitest';
import { createDefaultModel } from '../../cad/defaultModel';
import { executeCommand } from '../../cad/commandExecutor';
import { byId, sketchIndex } from '../../cad/modelGraph';
import type { ModelDefinition } from '../../cad/commandTypes';
import { decodeRenderMesh, geometryKey, MeshDecodeError } from './renderMesh';

const b64 = (arr: ArrayBufferView) =>
  btoa(String.fromCharCode(...new Uint8Array(arr.buffer, arr.byteOffset, arr.byteLength)));

const triangle = {
  objectId: 'box_1',
  positions: b64(new Float32Array([0, 0, 0, 10, 0, 0, 0, 10, 5])),
  indices: b64(new Uint32Array([0, 1, 2])),
  vertexCount: 3,
  triangleCount: 1,
};

describe('decodeRenderMesh', () => {
  it('base64 버퍼를 BufferGeometry 로 복원한다', () => {
    const g = decodeRenderMesh(triangle);
    expect(Array.from(g.getAttribute('position').array)).toEqual([0, 0, 0, 10, 0, 0, 0, 10, 5]);
    expect(Array.from(g.getIndex()!.array)).toEqual([0, 1, 2]);
    expect(g.boundingBox!.max.toArray()).toEqual([10, 10, 5]);
    expect(g.getAttribute('normal')).toBeDefined();
  });

  it('선언된 크기와 버퍼가 다르면 거부한다', () => {
    expect(() => decodeRenderMesh({ ...triangle, vertexCount: 4 })).toThrow(MeshDecodeError);
  });

  it('범위를 벗어난 인덱스를 거부한다 (GPU 에 잘못된 버퍼 전달 방지)', () => {
    expect(() => decodeRenderMesh({ ...triangle, indices: b64(new Uint32Array([0, 1, 9])) })).toThrow(
      MeshDecodeError,
    );
  });
});

describe('geometryKey', () => {
  it('치수가 같으면 위치·회전과 무관하게 같은 키', () => {
    const a = createDefaultModel().objects[0]!;
    const b = { ...a, transform: { position: [50, 0, 0] as [number, number, number], rotation: [0, 0, 90] as [number, number, number] } };
    expect(geometryKey(a, new Map())).toBe(geometryKey(b, new Map()));
    expect(geometryKey(a, new Map())).toBe('box:depth=20,height=20,width=20');
  });

  it('불리언 키는 자식의 치수와 부모 기준 위치를 포함한다 (구멍을 옮기면 키가 바뀜)', () => {
    const run = (m: ModelDefinition, c: unknown) => {
      const r = executeCommand(m, c);
      if (!r.ok) throw new Error(r.error);
      return r.model;
    };
    let m = run(createDefaultModel(), { type: 'create_cylinder', radius: 3, height: 30 });
    m = run(m, { type: 'cut', base: 'box_1', tools: ['cylinder_1'] });
    const key = (mm: ModelDefinition) => geometryKey(mm.objects.find((o) => o.id === 'cut_1')!, byId(mm));
    const before = key(m);
    expect(before).toBe('cut(box:depth=20,height=20,width=20@0,0,0|0,0,0;cylinder:height=30,radius=3@0,0,0|0,0,0)');

    // 불리언 자체를 옮기는 것은 키에 영향 없음 (메시 재사용)
    expect(key(run(m, { type: 'translate', target: 'cut_1', offset: [50, 0, 0] }))).toBe(before);
    // 구멍(자식)을 옮기면 키가 바뀜 (재계산 필요)
    expect(key(run(m, { type: 'translate', target: 'cylinder_1', offset: [5, 0, 0] }))).not.toBe(before);
  });
});

describe('geometryKey: 스케치 돌출', () => {
  const build = (...cmds: unknown[]) => {
    let m: ModelDefinition = { schemaVersion: 32, units: 'mm', sketches: [], objects: [] };
    for (const c of cmds) {
      const r = executeCommand(m, c);
      if (!r.ok) throw new Error(r.error);
      m = r.model;
    }
    return m;
  };
  const key = (m: ModelDefinition, id: string) => geometryKey(m.objects.find((o) => o.id === id)!, byId(m), sketchIndex(m));
  const PLATE = [
    { type: 'create_sketch', id: 'sk1' },
    { type: 'add_rectangle', sketch: 'sk1', id: 'r1', width: 60, height: 40 },
    { type: 'extrude', id: 'plate', sketch: 'sk1', profile: 'r1', distance: 4 },
  ];

  it('프로파일 치수를 포함 → 폭 수정 시 키가 바뀐다', () => {
    expect(key(build(...PLATE), 'plate')).toBe('extrude:rect:60x40@0,0,0|d=4');
    const m2 = build(...PLATE, { type: 'set_dimension', sketch: 'sk1', dimension: 'r1.width', value: 80 });
    expect(key(m2, 'plate')).toBe('extrude:rect:80x40@0,0,0|d=4');
  });

  it('구멍 뚫린 판(불리언)도 판 폭 수정 시 키가 바뀐다', () => {
    const holed = [
      ...PLATE,
      { type: 'create_sketch', id: 'sk2', plane: { type: 'XY', offset: -1 } },
      { type: 'add_circle', sketch: 'sk2', id: 'c1', center: [18, 0], diameter: 6 },
      { type: 'extrude', id: 'hole', sketch: 'sk2', profile: 'c1', distance: 6 },
      { type: 'cut', id: 'plate_holed', base: 'plate', tools: ['hole'] },
    ];
    const a = key(build(...holed), 'plate_holed');
    const b = key(build(...holed, { type: 'set_dimension', sketch: 'sk1', dimension: 'r1.width', value: 80 }), 'plate_holed');
    expect(a).not.toBe(b);
  });

  it('스케치를 넘기지 않으면 돌출 키에 프로파일이 없다 (호출자는 항상 넘겨야 함)', () => {
    const m = build(...PLATE);
    expect(geometryKey(m.objects[0]!, byId(m))).toBe('extrude:missing|d=4');
  });
});
