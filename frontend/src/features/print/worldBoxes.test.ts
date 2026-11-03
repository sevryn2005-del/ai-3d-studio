import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeCommand } from '../../cad/commandExecutor';
import { emptyModel, type ModelDefinition } from '../../cad/commandTypes';
import { byId } from '../../cad/modelGraph';
import { buildGeometry, geometryKey } from '../backend/renderMesh';
import { evaluateMeshes } from '../engine/browser/geometry';
import { worldBoxes } from './worldBoxes';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function build(...cmds: unknown[]): ModelDefinition {
  let m = emptyModel();
  for (const c of cmds) {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(r.error);
    m = r.model;
  }
  return m;
}

/** 브라우저 엔진으로 메시를 만들어 형상 키 캐시처럼 넣는다 */
function engineGeometries(m: ModelDefinition) {
  const index = byId(m);
  return Object.fromEntries(
    evaluateMeshes(wasm, m).map((mesh) => [geometryKey(index.get(mesh.objectId)!, index), buildGeometry({ ...mesh, welded: true })]),
  );
}

describe('worldBoxes', () => {
  // 옆으로 눕힌(X축 90°) 원통: 회전 중심이 밑면 중심이므로 절반이 바닥 아래로 내려간다
  const lying = build(
    { type: 'create_cylinder', id: 'pipe', radius: 10, height: 40 },
    { type: 'set_transform', target: 'pipe', rotation: [90, 0, 0] },
  );

  it('엔진 메시로 정확히: 눕힌 원통의 최저점 = -반지름', () => {
    const { boxes, exact } = worldBoxes(lying, engineGeometries(lying));
    expect(exact).toBe(true);
    const b = boxes.get('pipe')!;
    expect(b.min[2]).toBeCloseTo(-10, 2);
    expect(b.max[2]).toBeCloseTo(10, 2);
    expect(b.min[1]).toBeCloseTo(-40, 2);
  });

  it('메시가 없으면 꼭짓점 근사 (회전한 원통은 같거나 더 크게)', () => {
    const { boxes, exact } = worldBoxes(lying, {});
    expect(exact).toBe(false);
    expect(boxes.get('pipe')!.min[2]).toBeLessThanOrEqual(-10 + 1e-6);
  });

  it('45° 기울인 원통: 근사는 실제보다 크고, 엔진 메시는 정확하다', () => {
    const tilted = build(
      { type: 'create_cylinder', id: 'pipe', radius: 10, height: 40 },
      { type: 'set_transform', target: 'pipe', rotation: [45, 0, 0] },
    );
    const exactBox = worldBoxes(tilted, engineGeometries(tilted)).boxes.get('pipe')!;
    const approx = worldBoxes(tilted, {}).boxes.get('pipe')!;
    // 원 단면을 45° 기울이면 최저점 = -r·sin45° ≈ -7.07 (사각 근사는 -7.07 과 같거나 더 낮음)
    expect(exactBox.min[2]).toBeCloseTo(-10 * Math.SQRT1_2, 1);
    expect(approx.min[2]).toBeLessThanOrEqual(exactBox.min[2] + 1e-6);
  });
});
