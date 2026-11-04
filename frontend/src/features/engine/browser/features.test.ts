/**
 * 형식 v6 피처 (쉘·구멍·패턴·대칭·억제) — 브라우저 엔진. 서버 test_features.py 가 같은 공유 픽스처를 검사한다.
 */
import cases from '../../../../../shared/schemas/examples/feature-cases.json';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { ModelDefinitionSchema } from '../../../cad/commandTypes';
import { validateGraph } from '../../../cad/modelGraph';
import { needsPreciseEngine } from '../../../cad/features';
import { toBinaryStl } from './exporters';
import { worldMeshes } from './geometry';
import { stlCheck } from './stlCheck';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

describe('형식 v6 피처: 두 엔진 공유 픽스처 (해석적 부피, 닫힌 메시)', () => {
  // 정밀 피처(필렛·구배·STEP)는 manifold 가 아니라 OCCT 엔진이 계산한다 → occt/occtGeometry.test.ts
  const meshCases = Object.entries(cases).filter(([, c]) => !needsPreciseEngine(ModelDefinitionSchema.parse(c.model)));
  it.each(meshCases)('%s', (_name, c) => {
    const model = ModelDefinitionSchema.parse(c.model);
    expect(validateGraph(model)).toEqual([]);
    const meshes = worldMeshes(wasm, model, 0.01);
    expect(meshes.length).toBe(c.roots);
    const r = stlCheck(toBinaryStl(meshes));
    expect(r.bad).toBe(0);
    expect(Math.abs(r.volume - c.volume) / c.volume).toBeLessThan(3e-3);
    if ('bbox' in c && c.bbox) {
      const [lo, hi] = [[Infinity, Infinity, Infinity], [-Infinity, -Infinity, -Infinity]];
      for (const m of meshes)
        for (let i = 0; i < m.positions.length; i += 3)
          for (let k = 0; k < 3; k++) {
            lo[k] = Math.min(lo[k]!, m.positions[i + k]!);
            hi[k] = Math.max(hi[k]!, m.positions[i + k]!);
          }
      [...lo, ...hi].forEach((v, i) => expect(v).toBeCloseTo([...c.bbox![0]!, ...c.bbox![1]!][i]!, 3));
    }
  });
});
