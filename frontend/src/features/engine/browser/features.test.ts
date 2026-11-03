/**
 * 형식 v6 피처 (쉘·구멍·패턴·대칭·억제) — 브라우저 엔진. 서버 test_features.py 가 같은 공유 픽스처를 검사한다.
 */
import cases from '../../../../../shared/schemas/examples/feature-cases.json';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { ModelDefinitionSchema } from '../../../cad/commandTypes';
import { validateGraph } from '../../../cad/modelGraph';
import { toBinaryStl } from './exporters';
import { worldMeshes } from './geometry';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function stl(buf: Uint8Array) {
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(80, true);
  const key = (o: number) => [0, 1, 2].map((k) => dv.getFloat32(o + k * 4, true).toFixed(4)).join(',');
  const edges = new Map<string, number>();
  let volume = 0;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const p = [0, 1, 2].map((j) => [0, 1, 2].map((k) => dv.getFloat32(o + j * 12 + k * 4, true)));
    const [a, b, c] = p as [number[], number[], number[]];
    volume += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    const v = [0, 1, 2].map((j) => key(o + j * 12));
    for (let j = 0; j < 3; j++) edges.set(`${v[j]}>${v[(j + 1) % 3]}`, (edges.get(`${v[j]}>${v[(j + 1) % 3]}`) ?? 0) + 1);
  }
  let bad = 0;
  for (const [e, c] of edges) {
    const [a, b] = e.split('>');
    if (c !== 1 || edges.get(`${b}>${a}`) !== 1) bad++;
  }
  return { volume, bad };
}

describe('형식 v6 피처: 두 엔진 공유 픽스처 (해석적 부피, 닫힌 메시)', () => {
  it.each(Object.entries(cases))('%s', (_name, c) => {
    const model = ModelDefinitionSchema.parse(c.model);
    expect(validateGraph(model)).toEqual([]);
    const meshes = worldMeshes(wasm, model, 0.01);
    expect(meshes.length).toBe(c.roots);
    const r = stl(toBinaryStl(meshes));
    expect(r.bad).toBe(0);
    expect(Math.abs(r.volume - c.volume) / c.volume).toBeLessThan(3e-3);
  });
});
