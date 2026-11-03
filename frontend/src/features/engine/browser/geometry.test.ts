import fixture from '../../../../../shared/schemas/examples/model-cut-rotated.json';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { ModelDefinitionSchema, type ModelDefinition } from '../../../cad/commandTypes';
import { executeCommand } from '../../../cad/commandExecutor';
import { emptyModel } from '../../../cad/commandTypes';
import { byId } from '../../../cad/modelGraph';
import {
  circularSegments,
  evaluateMeshes,
  sphereSegments,
  GeometryError,
  localManifold,
  Scope,
  worldManifold,
  worldMeshes,
} from './geometry';

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

function bbox(positions: Float32Array) {
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < positions.length; i += 3)
    for (let k = 0; k < 3; k++) {
      min[k] = Math.min(min[k]!, positions[i + k]!);
      max[k] = Math.max(max[k]!, positions[i + k]!);
    }
  return { min, max };
}

/** 월드 좌표 객체의 부피 + 특정 점이 내부인지 (작은 정육면체와의 교차 부피로 판정) */
function probe(model: ModelDefinition, id: string) {
  const scope = new Scope();
  const index = byId(model);
  const solid = worldManifold(wasm, index.get(id)!, index, 0.01, scope);
  const volume = solid.volume();
  const inside = (p: [number, number, number]) => {
    const s = new Scope();
    try {
      const c = s.keep(s.keep(wasm.Manifold.cube([0.2, 0.2, 0.2], true)).translate(p));
      return s.keep(solid.intersect(c)).volume() > 0.0079; // 0.2³ = 0.008
    } finally {
      s.dispose();
    }
  };
  return { volume, inside, dispose: () => scope.dispose() };
}

describe('circularSegments', () => {
  it('현의 오차가 허용 오차 이하가 되도록 분할한다', () => {
    for (const r of [0.5, 3, 10, 100, 500]) {
      const n = circularSegments(r, 0.01);
      const chordError = r * (1 - Math.cos(Math.PI / n));
      expect(n % 4).toBe(0);
      if (n < 512) expect(chordError).toBeLessThanOrEqual(0.01);
    }
  });
});

describe('기본 도형: 서버와 같은 원점 규칙·치수', () => {
  it.each([
    ['box', { type: 'create_box', width: 80, depth: 50, height: 30 }, [-40, -25, 0], [40, 25, 30], 80 * 50 * 30],
    ['cylinder', { type: 'create_cylinder', radius: 5, height: 30 }, [-5, -5, 0], [5, 5, 30], Math.PI * 25 * 30],
    ['sphere', { type: 'create_sphere', radius: 10 }, [-10, -10, 0], [10, 10, 20], (4 / 3) * Math.PI * 1000],
    ['cone', { type: 'create_cone', radiusBottom: 10, radiusTop: 0, height: 20 }, [-10, -10, 0], [10, 10, 20], (Math.PI * 20 * 100) / 3],
    ['cone 같은 반지름', { type: 'create_cone', radiusBottom: 6, radiusTop: 6, height: 10 }, [-6, -6, 0], [6, 6, 10], Math.PI * 36 * 10],
  ])('%s', (_, cmd, min, max, exactVolume) => {
    const model = build(cmd);
    const [mesh] = evaluateMeshes(wasm, model, 0.01);
    const b = bbox(mesh!.positions);
    b.min.forEach((v, i) => expect(v).toBeCloseTo(min[i]!, 4));
    b.max.forEach((v, i) => expect(v).toBeCloseTo(max[i]!, 4));
    const p = probe(model, model.objects[0]!.id);
    // 다각형 근사의 부피 오차 상한: 표면 편차 ≤ 0.01mm 일 때 상대 오차 ≈ 3·tol/r (박스는 정확)
    const r = 'radius' in cmd ? cmd.radius : 'radiusBottom' in cmd ? Math.max(cmd.radiusBottom, cmd.radiusTop) : Infinity;
    expect(Math.abs(p.volume - exactVolume) / exactVolume).toBeLessThan(r === Infinity ? 1e-9 : (3 * 0.01) / r);
    p.dispose();
  });
});

describe('곡면의 실제 표면 편차 ≤ 출력 허용 오차 0.01mm', () => {
  it.each([0.5, 3, 10, 40])('구 r=%s', (r) => {
    const m = wasm.Manifold.sphere(r, sphereSegments(r, 0.01));
    const { vertProperties: p, triVerts: t } = m.getMesh();
    let maxDev = 0;
    for (let i = 0; i < t.length; i += 3) {
      const c = [0, 1, 2].map((k) => (p[t[i]! * 3 + k]! + p[t[i + 1]! * 3 + k]! + p[t[i + 2]! * 3 + k]!) / 3);
      maxDev = Math.max(maxDev, r - Math.hypot(...c));
    }
    m.delete();
    expect(maxDev).toBeLessThanOrEqual(0.01);
  });

  it.each([0.5, 3, 10, 100])('원 r=%s 의 현의 오차', (r) => {
    const n = circularSegments(r, 0.01);
    expect(r * (1 - Math.cos(Math.PI / n))).toBeLessThanOrEqual(0.01);
  });
});

describe('불리언', () => {
  it('박스 − 원통 = 관통 구멍', () => {
    const m = build(
      { type: 'create_box', width: 20, depth: 20, height: 20 },
      { type: 'create_cylinder', radius: 4, height: 30, position: [0, 0, -1] },
      { type: 'cut', base: 'box_1', tools: ['cylinder_1'] },
    );
    expect(evaluateMeshes(wasm, m).map((x) => x.objectId)).toEqual(['cut_1']);
    const p = probe(m, 'cut_1');
    expect(p.volume).toBeCloseTo(8000 - Math.PI * 16 * 20, -1);
    expect(p.inside([0, 0, 10])).toBe(false);
    expect(p.inside([8, 0, 10])).toBe(true);
    p.dispose();
  });

  it('겹치지 않는 교차는 서버와 같은 메시지로 거부', () => {
    const m = build(
      { type: 'create_box', width: 10, depth: 10, height: 10 },
      { type: 'create_box', width: 10, depth: 10, height: 10, position: [100, 0, 0] },
      { type: 'intersect', base: 'box_1', tools: ['box_2'] },
    );
    expect(() => evaluateMeshes(wasm, m)).toThrow(GeometryError);
    expect(() => evaluateMeshes(wasm, m)).toThrow('교차 결과가 비어 있습니다');
  });

  it('공유 픽스처: 45° 회전 판의 구멍이 월드 (60, 0) 에 있다 (서버 test_frontend_fixture 와 같은 검사)', () => {
    const model = ModelDefinitionSchema.parse(fixture);
    const p = probe(model, 'cut_1');
    expect(p.inside([60, 0, 2.5])).toBe(false);
    expect(p.inside([60, 2.8, 2.5])).toBe(false);
    expect(p.inside([60, 3.5, 2.5])).toBe(true);
    expect(p.inside([50, 0, 2.5])).toBe(true);
    expect(p.volume).toBeCloseTo(40 * 20 * 5 - Math.PI * 9 * 5, -1);
    p.dispose();
  });
});

describe('메시 계약', () => {
  it('evaluate 는 로컬 좌표, 내보내기용은 월드 좌표', () => {
    const m = build({ type: 'create_box', width: 10, depth: 10, height: 10, position: [100, 0, 0] });
    expect(bbox(evaluateMeshes(wasm, m)[0]!.positions).min).toEqual([-5, -5, 0]);
    expect(bbox(worldMeshes(wasm, m)[0]!.positions).min).toEqual([95, -5, 0]);
  });

  it('WASM 메모리를 해제한다 (반복 계산 후에도 객체가 누적되지 않음)', () => {
    const m = build(
      { type: 'create_box', width: 20, depth: 20, height: 20 },
      { type: 'create_sphere', radius: 12 },
      { type: 'cut', base: 'box_1', tools: ['sphere_1'] },
    );
    const scope = new Scope();
    const index = byId(m);
    localManifold(wasm, index.get('cut_1')!, index, 0.05, scope);
    // Scope 가 중간 결과까지 모두 추적: 박스(2) + 구(2) + 배치 변환(2) + 빼기 결과(1)
    expect((scope as unknown as { items: unknown[] }).items.length).toBe(7);
    scope.dispose();
    expect((scope as unknown as { items: unknown[] }).items.length).toBe(0);
    for (let i = 0; i < 50; i++) evaluateMeshes(wasm, m); // 누수 시 메모리 오류
  });
});
