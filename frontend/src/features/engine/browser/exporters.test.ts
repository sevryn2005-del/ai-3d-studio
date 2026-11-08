import { strFromU8, unzipSync } from 'fflate';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../../cad/commandExecutor';
import { emptyModel, type ModelDefinition } from '../../../cad/commandTypes';
import { worldMeshes } from './geometry';
import { boxUv, glbMaterial, linearRgba, to3mf, toBinaryStl, toGlb } from './exporters';

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
    // 박스 투영 UV: 점마다 하나, 윗면(glTF 법선 +Y = CAD +Z) 점은 uv = (x, −y_CAD) m = (pos.x, pos.z)
    const { arr: uv } = acc(prim.attributes.TEXCOORD_0);
    expect(uv.length / 2).toBe(pos.length / 3);
    let top = 0;
    for (let i = 0, j = 0; i < pos.length; i += 3, j += 2)
      if (nrm[i + 1]! > 0.99) {
        top++;
        expect(uv[j]!).toBeCloseTo(pos[i]!, 6);
        expect(uv[j + 1]!).toBeCloseTo(pos[i + 2]!, 6);
      }
    expect(top).toBeGreaterThan(0);
    // 높이 50mm 박스(x=30) → x 0.02~0.04, y(위) 0~0.05, z −0.01~0.01
    a.min.forEach((v: number, i: number) => expect(v).toBeCloseTo([0.02, 0, -0.01][i]!, 6));
    a.max.forEach((v: number, i: number) => expect(v).toBeCloseTo([0.04, 0.05, 0.01][i]!, 6));
    for (let i = 0; i < nrm.length; i += 3) expect(Math.hypot(nrm[i]!, nrm[i + 1]!, nrm[i + 2]!)).toBeCloseTo(1, 4);
    const tris: number[][][] = [];
    for (let i = 0; i < pos.length; i += 9) tris.push([0, 1, 2].map((v) => [0, 1, 2].map((k) => pos[i + v * 3 + k]!)));
    expect(volume(tris) / (20 * 20 * 50 * 1e-9)).toBeCloseTo(1, 5); // 축 변환 후에도 바깥 방향 (Float32 정밀도 → 상대 비교)
  });
});

describe('3MF 외관 색 (서버 test_export.py 와 같은 구조)', () => {
  it('색이 있는 객체만 basematerials 의 pid/pindex 를 갖고, 객체 id 는 1..n', () => {
    const tri = { positions: Float32Array.from([0, 0, 0, 1, 0, 0, 0, 1, 0, 0, 0, 1]), indices: Uint32Array.from([0, 2, 1, 0, 1, 3, 1, 2, 3, 0, 3, 2]) };
    const zip = to3mf([{ name: 'a', color: '#e5534b', ...tri }, { name: 'b', ...tri }, { name: 'c', color: '#57ab5a', ...tri }]);
    const xml = new TextDecoder().decode(unzipSync(zip)['3D/3dmodel.model']!);
    expect(xml).toContain('<basematerials id="4">');
    expect(xml).toContain('displaycolor="#E5534B"');
    expect(xml).toMatch(/<object id="1"[^>]*pid="4" pindex="0"/);
    expect(xml).toMatch(/<object id="2" type="model" name="b">/);
    expect(xml).toMatch(/<object id="3"[^>]*pid="4" pindex="1"/);
  });
});

describe('박스 투영 UV (서버 exporter.py box_uv 와 같은 값)', () => {
  it('가장 큰 법선 축의 면, 음수 쪽은 뒤집기, v 는 이미지 좌표', () => {
    expect(boxUv(10, 20, 30, 0, 0, 1)).toEqual([0.01, -0.02]); // 윗면: u = x, v = −y
    expect(boxUv(10, 20, 30, 0, 0, -1)).toEqual([0.01, 0.02]); // 아랫면: v = y
    expect(boxUv(10, 20, 30, 1, 0, 0)).toEqual([0.02, -0.03]); // +X 면: u = y, v = −z
    expect(boxUv(10, 20, 30, -1, 0, 0)).toEqual([-0.02, -0.03]);
    expect(boxUv(10, 20, 30, 0, 1, 0)).toEqual([-0.01, -0.03]); // +Y 면: u = −x
    expect(boxUv(10, 20, 30, 0, -1, 0)).toEqual([0.01, -0.03]);
    expect(boxUv(10, 20, 30, 0.6, 0.6, 0.5)).toEqual([0.02, -0.03]); // 같으면 X 먼저
  });
});

describe('GLB 재질 (형식 v29, 서버 exporter.py 와 같은 값)', () => {
  it('sRGB → 선형 색, 객체별 재질 (같은 색·재질은 하나), 없으면 기본', () => {
    expect(linearRgba('#ffffff')).toEqual([1, 1, 1, 1]);
    expect(linearRgba('#808080')).toEqual([0.215861, 0.215861, 0.215861, 1]);
    expect(linearRgba('#e5534b')).toEqual([0.783538, 0.0865, 0.070360, 1]);
    expect(glbMaterial(undefined, undefined)).toEqual({ name: 'default m0.05 r0.55', pbrMetallicRoughness: { baseColorFactor: [0.64, 0.68, 0.73, 1], metallicFactor: 0.05, roughnessFactor: 0.55 } });
    expect(glbMaterial('#e5534b', { metallic: 1, roughness: 0.2 }).name).toBe('#e5534b m1 r0.2');
    const tri = { positions: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), indices: new Uint32Array([0, 1, 2]) };
    const data = toGlb([
      { name: 'a', color: '#e5534b', material: { metallic: 1, roughness: 0.2 }, ...tri },
      { name: 'b', ...tri },
      { name: 'c', color: '#e5534b', material: { metallic: 1, roughness: 0.2 }, ...tri },
    ]);
    const dv = new DataView(data.buffer, data.byteOffset);
    const gltf = JSON.parse(strFromU8(data.subarray(20, 20 + dv.getUint32(12, true))));
    expect(gltf.materials).toHaveLength(2);
    expect(gltf.meshes.map((m: { primitives: { material: number }[] }) => m.primitives[0]!.material)).toEqual([0, 1, 0]);
    expect(gltf.materials[0].pbrMetallicRoughness).toEqual({ baseColorFactor: [0.783538, 0.0865, 0.07036, 1], metallicFactor: 1, roughnessFactor: 0.2 });
  });
});


describe('GLB 텍스처 (형식 v30, 서버 exporter.py 와 같은 규칙)', () => {
  const PNG_1PX = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC';
  it('색 없으면 흰색 + baseColorTexture, 이름에 t{번호}', () => {
    expect(glbMaterial(undefined, undefined, 0)).toEqual({
      name: 'default m0.05 r0.55 t0',
      pbrMetallicRoughness: { baseColorFactor: [1, 1, 1, 1], metallicFactor: 0.05, roughnessFactor: 0.55, baseColorTexture: { index: 0 } },
    });
    expect(glbMaterial('#e5534b', undefined, 1).pbrMetallicRoughness.baseColorFactor).toEqual([0.783538, 0.0865, 0.07036, 1]);
  });
  it('이미지는 한 번만 넣고, UV 는 객체 로컬 좌표 / tile', () => {
    // 객체가 x = 100 에 있음: 월드 삼각형 (100,0,0)(110,0,0)(100,10,0) → 로컬 (0,0)(10,0)(0,10), 윗면 (u = x, v = −y) / 20
    const toLocal = [1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, -100, 0, 0, 1];
    const tri = { positions: new Float32Array([100, 0, 0, 110, 0, 0, 100, 10, 0]), indices: new Uint32Array([0, 1, 2]) };
    const texture = { image: PNG_1PX, tile: 20 };
    const data = toGlb([
      { name: 'a', texture, toLocal, ...tri },
      { name: 'b', texture, toLocal, ...tri },
    ]);
    const dv = new DataView(data.buffer, data.byteOffset);
    const jlen = dv.getUint32(12, true);
    const gltf = JSON.parse(strFromU8(data.subarray(20, 20 + jlen)));
    const bin = data.subarray(28 + jlen);
    expect(gltf.images).toHaveLength(1);
    expect(gltf.images[0].mimeType).toBe('image/png');
    const iv = gltf.bufferViews[gltf.images[0].bufferView];
    expect(iv.target).toBeUndefined();
    expect(btoa(String.fromCharCode(...bin.subarray(iv.byteOffset, iv.byteOffset + iv.byteLength)))).toBe(PNG_1PX.split(',')[1]);
    expect(gltf.textures).toEqual([{ source: 0, sampler: 0 }]);
    expect(gltf.samplers[0].wrapS).toBe(10497);
    expect(gltf.materials).toHaveLength(1);
    expect(gltf.materials[0].pbrMetallicRoughness.baseColorTexture).toEqual({ index: 0 });
    const acc = gltf.accessors[gltf.meshes[0].primitives[0].attributes.TEXCOORD_0];
    const bv = gltf.bufferViews[acc.bufferView];
    const uv = [...new Float32Array(bin.slice(bv.byteOffset, bv.byteOffset + bv.byteLength).buffer)].map((x) => Math.round(x * 1e6) / 1e6 + 0);
    expect(uv).toEqual([0, 0, 0.5, 0, 0, -0.5]);
  });
});
