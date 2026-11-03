import { describe, expect, it } from 'vitest';
import { createDefaultModel } from '../../cad/defaultModel';
import { executeCommand } from '../../cad/commandExecutor';
import { byId } from '../../cad/modelGraph';
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
