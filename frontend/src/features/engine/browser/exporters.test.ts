import { strFromU8, unzipSync } from 'fflate';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../../cad/commandExecutor';
import { emptyModel, type ModelDefinition } from '../../../cad/commandTypes';
import { worldMeshes } from './geometry';
import { to3mf, toBinaryStl, toGlb } from './exporters';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

/** 높이 50 박스(x=30) + 반지름 10 원통(x=−30, 이름에 XML 특수 문자) */
function twoObjects(): ModelDefinition {
  let m = emptyModel();
  for (const c of [
    { type: 'create_box', name: '큐브', width: 20, depth: 20, height: 50, position: [30, 0, 0] },
    { type: 'create_cylinder', name: '원통 <1> & "따옴표"', radius: 10, height: 10, position: [-30, 0, 0] },
  ]) {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(r.error);
    m = r.model;
  }
  return m;
}

function volume(tris: number[][][]): number {
  let v = 0;
  for (const [a, b, c] of tris) {
    v += a![0]! * (b![1]! * c![2]! - b![2]! * c![1]!) - a![1]! * (b![0]! * c![2]! - b![2]! * c![0]!) + a![2]! * (b![0]! * c![1]! - b![1]! * c![0]!);
  }
  return v / 6;
}

describe('STL', () => {
  it('월드 좌표 mm, 바이너리 구조, 부피(법선 바깥 방향)', () => {
    const data = toBinaryStl(worldMeshes(wasm, twoObjects()));
    const dv = new DataView(data.buffer);
    const count = dv.getUint32(80, true);
    expect(data.length).toBe(84 + count * 50);
    const tris: number[][][] = [];
    for (let i = 0; i < count; i++) {
      const o = 84 + i * 50 + 12;
      tris.push([0, 1, 2].map((v) => [0, 1, 2].map((k) => dv.getFloat32(o + v * 12 + k * 4, true))));
    }
    const zs = tris.flat().map((p) => p[2]!);
    expect(Math.max(...zs)).toBeCloseTo(50, 5);
    expect(volume(tris)).toBeCloseTo(20 * 20 * 50 + Math.PI * 100 * 10, -1);
  });
});

describe('3MF', () => {
  it('사양 준수: 단위 mm, 객체 ID 1부터, 이름 이스케이프, 매니폴드·면 방향 일관성', () => {
    const files = unzipSync(to3mf(worldMeshes(wasm, twoObjects())));
    expect(Object.keys(files).sort()).toEqual(['3D/3dmodel.model', '[Content_Types].xml', '_rels/.rels']);
    const xml = strFromU8(files['3D/3dmodel.model']!);
    expect(xml).toContain('unit="millimeter"');
    expect([...xml.matchAll(/<object id="(\d+)"[^>]*name="([^"]*)"/g)].map((m) => [m[1], m[2]])).toEqual([
      ['1', '큐브'],
      ['2', '원통 &lt;1&gt; &amp; &quot;따옴표&quot;'],
    ]);
    expect([...xml.matchAll(/<item objectid="(\d+)"/g)].map((m) => m[1])).toEqual(['1', '2']);

    for (const obj of xml.split('<object ').slice(1)) {
      const v = [...obj.matchAll(/<vertex x="([^"]+)" y="([^"]+)" z="([^"]+)"/g)].map((m) => [+m[1]!, +m[2]!, +m[3]!]);
      const t = [...obj.matchAll(/<triangle v1="(\d+)" v2="(\d+)" v3="(\d+)"/g)].map((m) => [+m[1]!, +m[2]!, +m[3]!]);
      const directed = new Map<string, number>();
      for (const [a, b, c] of t) for (const [x, y] of [[a, b], [b, c], [c, a]]) directed.set(`${x},${y}`, (directed.get(`${x},${y}`) ?? 0) + 1);
      for (const [e, n] of directed) {
        expect(n).toBe(1);
        const [x, y] = e.split(',');
        expect(directed.get(`${y},${x}`)).toBe(1); // 모든 모서리를 반대 방향 삼각형이 정확히 한 번 공유
      }
      expect(volume(t.map((tri) => tri.map((i) => v[i]!)))).toBeGreaterThan(0);
    }
  });
});

describe('GLB', () => {
  it('glTF 2.0 구조, Y-up 미터, 법선 단위 길이, 면 방향 유지', () => {
    const data = toGlb(worldMeshes(wasm, twoObjects()));
    const dv = new DataView(data.buffer, data.byteOffset);
    expect(strFromU8(data.subarray(0, 4))).toBe('glTF');
    expect(dv.getUint32(4, true)).toBe(2);
    expect(dv.getUint32(8, true)).toBe(data.length);
    const jsonLen = dv.getUint32(12, true);
    expect(jsonLen % 4).toBe(0);
    const gltf = JSON.parse(strFromU8(data.subarray(20, 20 + jsonLen)));
    const binStart = 28 + jsonLen;
    expect(dv.getUint32(20 + jsonLen, true)).toBe(gltf.buffers[0].byteLength);
    expect(gltf.nodes.map((n: { name: string }) => n.name)).toEqual(['큐브', '원통 <1> & "따옴표"']);

    const prim = gltf.meshes[0].primitives[0];
    const acc = (i: number) => {
      const a = gltf.accessors[i];
      const view = gltf.bufferViews[a.bufferView];
      expect(view.byteOffset % 4).toBe(0);
      return { a, arr: new Float32Array(data.buffer.slice(data.byteOffset + binStart + view.byteOffset, data.byteOffset + binStart + view.byteOffset + view.byteLength)) };
    };
    const { a, arr: pos } = acc(prim.attributes.POSITION);
    const { arr: nrm } = acc(prim.attributes.NORMAL);
    // 높이 50mm 박스(x=30) → x 0.02~0.04, y(위) 0~0.05, z −0.01~0.01
    a.min.forEach((v: number, i: number) => expect(v).toBeCloseTo([0.02, 0, -0.01][i]!, 6));
    a.max.forEach((v: number, i: number) => expect(v).toBeCloseTo([0.04, 0.05, 0.01][i]!, 6));
    for (let i = 0; i < nrm.length; i += 3) expect(Math.hypot(nrm[i]!, nrm[i + 1]!, nrm[i + 2]!)).toBeCloseTo(1, 4);
    const tris: number[][][] = [];
    for (let i = 0; i < pos.length; i += 9) tris.push([0, 1, 2].map((v) => [0, 1, 2].map((k) => pos[i + v * 3 + k]!)));
    expect(volume(tris) / (20 * 20 * 50 * 1e-9)).toBeCloseTo(1, 5); // 축 변환 후에도 바깥 방향 (Float32 정밀도 → 상대 비교)
  });
});
