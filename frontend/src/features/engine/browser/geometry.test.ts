import fixture from '../../../../../shared/schemas/examples/model-cut-rotated.json';
import plateFixture from '../../../../../shared/schemas/examples/model-sketch-plate.json';
import planesFixture from '../../../../../shared/schemas/examples/model-sketch-planes.json';
import faceFixture from '../../../../../shared/schemas/examples/model-face-sketch.json';
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import { ModelDefinitionSchema, type ModelDefinition } from '../../../cad/commandTypes';
import { executeCommand } from '../../../cad/commandExecutor';
import { emptyModel } from '../../../cad/commandTypes';
import { byId, sketchIndex } from '../../../cad/modelGraph';
import { toBinaryStl } from './exporters';
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
  const solid = worldManifold(wasm, index.get(id)!, index, 0.01, scope, sketchIndex(model));
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

describe('스케치 돌출 (공유 픽스처: 서버 test_sketch_extrude.py 와 같은 검사)', () => {
  const PLATE_VOLUME = 80 * 40 * 4 - Math.PI * 9 * 4;

  it('기준 판 80×40×4 + 관통 구멍 Ø6 이 (18, 0) 에 있다', () => {
    const model = ModelDefinitionSchema.parse(plateFixture);
    expect(evaluateMeshes(wasm, model).map((x) => x.objectId)).toEqual(['plate_holed']);
    const p = probe(model, 'plate_holed');
    expect(p.inside([18, 0, 2])).toBe(false);
    expect(p.inside([18, 3.5, 2])).toBe(true);
    expect(p.inside([-18, 0, 2])).toBe(true);
    expect(Math.abs(p.volume - PLATE_VOLUME)).toBeLessThan(0.01 * 2 * Math.PI * 3 * 4 + 1e-3);
    p.dispose();
    const b = bbox(worldMeshes(wasm, model)[0]!.positions);
    expect(b.min).toEqual([-40, -20, 0]);
    expect(b.max).toEqual([40, 20, 4]);
  });

  it('원본 치수만 바꾸면 결과가 다시 계산된다 (폭 90)', () => {
    const m = build(
      { type: 'create_sketch', id: 'sk' },
      { type: 'add_rectangle', sketch: 'sk', width: 60, height: 40 },
      { type: 'extrude', id: 'plate', sketch: 'sk', profile: 'rect1', distance: 4 },
      { type: 'set_dimension', sketch: 'sk', dimension: 'rect1.width', value: 90 },
    );
    const b = bbox(evaluateMeshes(wasm, m)[0]!.positions);
    expect(b.min).toEqual([-45, -20, 0]);
    expect(b.max).toEqual([45, 20, 4]);
  });

  it('XZ·YZ 평면: 서버(CadQuery 이름 평면)와 같은 월드 바운딩 박스', () => {
    const model = ModelDefinitionSchema.parse(planesFixture);
    const ids = model.objects.map((o) => o.id); // worldMeshes 는 최상위 객체 순서
    const boxes = Object.fromEntries(worldMeshes(wasm, model).map((m, i) => [ids[i]!, bbox(m.positions)]));
    const expectBox = (id: string, min: number[], max: number[]) => {
      boxes[id]!.min.forEach((v, k) => expect(v).toBeCloseTo(min[k]!, 3));
      boxes[id]!.max.forEach((v, k) => expect(v).toBeCloseTo(max[k]!, 3));
    };
    expectBox('front', [-10, -7, 0], [20, -3, 20]);
    expectBox('side', [-2, -3, 3], [4, 7, 13]);
    expectBox('front_moved', [3, -10, 5], [7, 20, 25]);
    const p = probe(model, 'side');
    expect(Math.abs(p.volume - Math.PI * 25 * 6)).toBeLessThan(0.01 * Math.PI * 10 * 6 + 1e-3);
    p.dispose();
  });

  it('면 위 스케치: 판 윗면 기둥·홈, 옆면 돌기 (서버 test_face_sketch.py 와 같은 기대값)', () => {
    const model = ModelDefinitionSchema.parse(faceFixture);
    const meshes = worldMeshes(wasm, model);
    expect(meshes).toHaveLength(1); // part 하나
    const b = bbox(meshes[0]!.positions);
    b.min.forEach((v, k) => expect(v).toBeCloseTo([-10, -45, 0][k]!, 3));
    b.max.forEach((v, k) => expect(v).toBeCloseTo([30, 40, 10][k]!, 3));
    const p = probe(model, 'part');
    const exact = 80 * 40 * 4 - 10 * 6 * 3 + Math.PI * 25 * 6 + Math.PI * 9 * 5;
    expect(Math.abs(p.volume - exact)).toBeLessThan(0.01 * (2 * Math.PI * 5 * 6 + 2 * Math.PI * 3 * 5) + 1e-3);
    expect(p.inside([10, 0, 2.5])).toBe(false); // 홈 (z 1..4)
    expect(p.inside([10, 0, 0.5])).toBe(true); // 홈 아래 판
    expect(p.inside([10, 8, 8])).toBe(true); // 기둥
    expect(p.inside([10, -43, 3])).toBe(true); // 옆면 돌기
    expect(p.inside([0, 30, 2])).toBe(true); // 판
    p.dispose();
  });

  it('스케치가 없으면 형상 오류', () => {
    const model = ModelDefinitionSchema.parse(plateFixture);
    const scope = new Scope();
    const index = byId(model);
    expect(() => localManifold(wasm, index.get('plate')!, index, 0.05, scope)).toThrow(GeometryError);
    scope.dispose();
  });

  it('STL 출력: 월드 치수·부피·닫힌 메시', () => {
    const data = toBinaryStl(worldMeshes(wasm, ModelDefinitionSchema.parse(plateFixture)));
    const dv = new DataView(data.buffer);
    const count = dv.getUint32(80, true);
    const edges = new Map<string, number>();
    let vol = 0;
    const key = (o: number) => [0, 1, 2].map((k) => dv.getFloat32(o + k * 4, true).toFixed(4)).join(',');
    for (let i = 0; i < count; i++) {
      const o = 84 + i * 50 + 12;
      const v = [0, 1, 2].map((j) => [0, 1, 2].map((k) => dv.getFloat32(o + j * 12 + k * 4, true)));
      const [a, b, c] = v as [number[], number[], number[]];
      vol += a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
      const ks = [0, 1, 2].map((j) => key(o + j * 12));
      for (let j = 0; j < 3; j++) {
        const e = [ks[j]!, ks[(j + 1) % 3]!].sort().join('|');
        edges.set(e, (edges.get(e) ?? 0) + 1);
      }
    }
    expect(Math.abs(vol / 6 - PLATE_VOLUME) / PLATE_VOLUME).toBeLessThan(2e-3);
    expect([...edges.values()].every((n) => n === 2)).toBe(true); // 닫힌(새지 않는) 메시
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

describe('모서리 처리 (서버 OCCT 와 같은 형상: 부피로 비교)', () => {
  // 30×20×10 박스, 크기 2. 서버(CadQuery) 측정값: test_primitives.py 와 같은 수치
  const SERVER = { 'fillet all': 5804.6961, 'fillet vertical': 5965.6637, 'chamfer all': 5562.6667, 'chamfer vertical': 5920 };
  it.each(Object.entries(SERVER))('%s', (name, expected) => {
    const [type, edges] = name.split(' ') as ['fillet' | 'chamfer', 'all' | 'vertical'];
    const m = build(
      { type: 'create_box', id: 'b', width: 30, depth: 20, height: 10 },
      type === 'fillet' ? { type, target: 'b', radius: 2, edges } : { type, target: 'b', distance: 2, edges },
    );
    const p = probe(m, 'b');
    // 곡면 다각형 근사의 부피 오차 ≤ 허용 오차(0.01mm) × 곡면 넓이. 모따기는 평면뿐이라 정확히 같아야 한다.
    const r = 2, a = 26, b2 = 16, c = 6;
    const curvedArea = name === 'fillet all' ? 2 * Math.PI * r * (a + b2 + c) + 4 * Math.PI * r * r
      : name === 'fillet vertical' ? 2 * Math.PI * r * 10 : 0;
    expect(Math.abs(p.volume - expected)).toBeLessThanOrEqual(0.01 * curvedArea + 1e-3);
    const [mesh] = evaluateMeshes(wasm, m, 0.01);
    const b = bbox(mesh!.positions);
    b.min.forEach((v, i) => expect(v).toBeCloseTo([-15, -10, 0][i]!, 3)); // 원점 규칙 유지
    b.max.forEach((v, i) => expect(v).toBeCloseTo([15, 10, 10][i]!, 3));
    p.dispose();
  });
});
