/**
 * 다른 CAD·블렌더에서 실제로 보고된 문제가 우리 앱에서는 생기지 않는지 확인하는 회귀 테스트 (docs/issue-survey.md).
 * 브라우저 엔진(manifold) 쪽. 서버(OCCT) 쪽은 backend/tests/test_issue_survey.py 가 같은 경우를 검사한다.
 */
import Module, { type ManifoldToplevel } from 'manifold-3d';
import { beforeAll, describe, expect, it } from 'vitest';
import survey from '../../../../../shared/schemas/examples/survey-cases.json';
import { ModelDefinitionSchema, emptyModel, type ModelDefinition } from '../../../cad/commandTypes';
import { executeCommand } from '../../../cad/commandExecutor';
import { toBinaryStl } from './exporters';
import { evaluateMeshes, worldMeshes } from './geometry';

let wasm: ManifoldToplevel;
beforeAll(async () => {
  wasm = await Module();
  wasm.setup();
});

function run(model: ModelDefinition, cmd: unknown) {
  return executeCommand(model, cmd);
}
function build(...cmds: unknown[]): ModelDefinition {
  let m = emptyModel();
  for (const c of cmds) {
    const r = run(m, c);
    if (!r.ok) throw new Error(`${JSON.stringify(c)}: ${r.error}`);
    m = r.model;
  }
  return m;
}

/** STL 을 다시 읽어 닫힌 메시(모든 모서리를 정확히 두 삼각형이 반대 방향으로 공유)·부호 있는 부피 검사 */
function stlCheck(model: ModelDefinition) {
  const buf = toBinaryStl(worldMeshes(wasm, model, 0.01));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const n = dv.getUint32(80, true);
  const key = (o: number) => [0, 1, 2].map((k) => dv.getFloat32(o + k * 4, true).toFixed(5)).join(',');
  const edges = new Map<string, number>();
  let volume = 0;
  for (let i = 0; i < n; i++) {
    const o = 84 + i * 50 + 12;
    const v = [0, 1, 2].map((j) => key(o + j * 12));
    const p = [0, 1, 2].map((j) => [0, 1, 2].map((k) => dv.getFloat32(o + j * 12 + k * 4, true))) as number[][];
    const [a, b, c] = p as [number[], number[], number[]];
    volume += (a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!)) / 6;
    for (let j = 0; j < 3; j++) {
      const e = `${v[j]}>${v[(j + 1) % 3]}`;
      edges.set(e, (edges.get(e) ?? 0) + 1);
    }
  }
  // 방향 있는 모서리 a>b 는 정확히 한 번, 그 반대 b>a 도 정확히 한 번 → 닫힌 2-다양체, 법선 일관
  let bad = 0;
  for (const [e, count] of edges) {
    const [a, b] = e.split('>');
    if (count !== 1 || edges.get(`${b}>${a}`) !== 1) bad++;
  }
  return { triangles: n, volume, badEdges: bad };
}

describe('4-3 · 4-5 · 7-3 · 7-4: 두께 0 · 맞닿음 · 접하는 컷 · 같은 평면 관통 컷 · 축 위 회전 → 닫힌 메시, 양의 부피 (공유 픽스처)', () => {
  it.each(Object.entries(survey))('%s', (_name, c) => {
    const m = ModelDefinitionSchema.parse(c.model);
    const r = stlCheck(m);
    expect(r.badEdges).toBe(0);
    expect(r.volume).toBeGreaterThan(0);
    expect(Math.abs(r.volume - c.volume) / c.volume).toBeLessThan(3e-3);
  });

  it('모서리 하나만 공유하는 합치기: 실패하지 않고 양의 부피 (비다양체 모서리는 출력 검사가 경고)', () => {
    const m = build(
      { type: 'create_box', id: 'a', width: 10, depth: 10, height: 10 },
      { type: 'create_box', id: 'b', width: 10, depth: 10, height: 10, position: [10, 10, 0] },
      { type: 'union', id: 'u', base: 'a', tools: ['b'] },
    );
    const r = stlCheck(m);
    expect(Math.abs(r.volume - 2000)).toBeLessThan(0.01);
  });

});

describe('4-1: 필렛·모따기 반지름 과대 — 원본 유지, 최대값 안내, 경계 일치', () => {
  const box = { type: 'create_box', id: 'b', width: 10, depth: 20, height: 30 };
  it('가장 짧은 변의 절반(5mm) 미만은 성공', () => {
    const m = build(box, { type: 'fillet', target: 'b', radius: 4.99 });
    expect(stlCheck(m).badEdges).toBe(0);
  });
  it.each([5, 5.01])('%smm 는 거부되고, 원본 그대로, 최대값을 알려 준다', (r) => {
    const m = build(box);
    const res = run(m, { type: 'fillet', target: 'b', radius: r });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/5\s*mm/);
  });
});

describe('3-2: 치수를 줄였을 때 기존 필렛이 조용히 깨지지 않는다', () => {
  it('필렛 R4 박스의 높이를 6 으로 줄이면 거부 + 이유, 원래대로면 그대로', () => {
    const m = build({ type: 'create_box', id: 'b', width: 20, depth: 20, height: 20 }, { type: 'fillet', target: 'b', radius: 4 });
    const res = run(m, { type: 'set_params', target: 'b', params: { height: 6 } });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toMatch(/필렛|모서리/);
    const ok = run(m, { type: 'set_params', target: 'b', params: { height: 12 } });
    expect(ok.ok).toBe(true);
  });
});

describe('2-4 · 4-5 · 4-6: 열린·꼬인·길이 0 스케치는 엔진에 넘기기 전에 거부', () => {
  const sk = { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } };
  it.each([
    ['같은 점이 연속 (길이 0 변)', [[0, 0], [10, 0], [10, 0], [0, 10]]],
    ['첫 점과 끝 점이 사실상 같음 (1e-5mm)', [[0, 0], [10, 0], [10, 10], [0, 1e-5]]],
    ['8자 모양 (자기 교차)', [[0, 0], [10, 10], [10, 0], [0, 10]]],
    ['일직선 (넓이 0)', [[0, 0], [5, 0], [10, 0]]],
  ])('%s', (_name, points) => {
    const m = build(sk);
    const res = run(m, { type: 'add_polygon', sketch: 's', id: 'p', points });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.length).toBeGreaterThan(5);
  });

  it('회전축(v 축)을 가로지르는 프로파일은 회전 거부 (축에 닿는 경우는 공유 픽스처에서 성공 확인)', () => {
    const m = build(sk, { type: 'add_rectangle', sketch: 's', id: 'x', center: [0, 5], width: 10, height: 10 });
    const res = run(m, { type: 'revolve', id: 'v', sketch: 's', profile: 'x', angle: 360 });
    expect(res.ok).toBe(false);
  });
});

describe('2-1 · 2-2: 모순 구속은 멈추지 않고 거부, 치수 왕복에도 모양이 뒤집히지 않는다', () => {
  const base = () =>
    build(
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_polygon', sketch: 's', id: 'p', points: [[0, 0], [40, 1], [41, 20], [-1, 19]] },
      { type: 'add_constraint', sketch: 's', id: 'f', constraint: 'fix', refs: ['p.p0'] },
      { type: 'add_constraint', sketch: 's', id: 'h0', constraint: 'horizontal', refs: ['p.e0'] },
      { type: 'add_constraint', sketch: 's', id: 'v1', constraint: 'vertical', refs: ['p.e1'] },
      { type: 'add_constraint', sketch: 's', id: 'h2', constraint: 'horizontal', refs: ['p.e2'] },
      { type: 'add_constraint', sketch: 's', id: 'l0', constraint: 'length', refs: ['p.e0'], value: 40 },
      { type: 'add_constraint', sketch: 's', id: 'l1', constraint: 'length', refs: ['p.e1'], value: 20 },
    );

  it('모순(같은 변에 다른 길이) 은 빠르게 거부되고 원본 그대로', () => {
    const m = base();
    const t0 = performance.now();
    const res = run(m, { type: 'add_constraint', sketch: 's', id: 'bad', constraint: 'length', refs: ['p.e0'], value: 30 });
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(res.ok).toBe(false);
    // 어느 구속끼리 충돌하는지 이름으로 알려 준다 (고정·수평처럼 관계없는 구속은 빠짐)
    if (!res.ok) {
      expect(res.error).toContain('l0');
      expect(res.error).toContain('bad');
      expect(res.error).not.toContain('h0');
    }
  });

  it('중복이지만 일관된 구속(같은 수평 두 번)은 모양을 바꾸지 않는다', () => {
    const m = base();
    const res = run(m, { type: 'add_constraint', sketch: 's', id: 'dup', constraint: 'horizontal', refs: ['p.e0'] });
    if (res.ok) expect(res.model.sketches[0]!.entities).toEqual(m.sketches[0]!.entities);
    else expect(res.error).toMatch(/이미|중복|과구속/);
  });

  it('길이 40 → 5 → 40 왕복: 원래 좌표로 돌아오고, 변 방향이 뒤집히지 않는다', () => {
    let m = base();
    const before = JSON.stringify(m.sketches[0]!.entities);
    for (const v of [5, 0.5, 5, 40]) {
      const r = run(m, { type: 'set_constraint', sketch: 's', constraint: 'l0', value: v });
      expect(r.ok).toBe(true);
      if (r.ok) m = r.model;
      const pts = (m.sketches[0]!.entities[0] as { points: number[][] }).points;
      expect(pts[1]![0]! - pts[0]![0]!).toBeGreaterThan(0); // p1 이 계속 p0 의 +X 쪽
    }
    const after = (m.sketches[0]!.entities[0] as { points: number[][] }).points;
    const orig = (JSON.parse(before)[0] as { points: number[][] }).points;
    after.forEach((p, i) => p.forEach((v, k) => expect(v).toBeCloseTo(orig[i]![k]!, 4)));
  });
});

describe('7-1 · 9-2: 작은 구멍의 다각형 근사가 지름을 크게 줄이지 않는다 (출력 허용 오차 0.01mm)', () => {
  it.each([1.5, 2.5, 50])('반지름 %smm 구멍', (r) => {
    const m = build(
      { type: 'create_box', id: 'a', width: 4 * r + 10, depth: 4 * r + 10, height: 5 },
      { type: 'create_cylinder', id: 'c', radius: r, height: 5 },
      { type: 'cut', id: 'k', base: 'a', tools: ['c'] },
    );
    const [mesh] = evaluateMeshes(wasm, m, 0.01);
    let minR = Infinity;
    const p = mesh!.positions;
    for (let i = 0; i < p.length; i += 3) {
      const d = Math.hypot(p[i]!, p[i + 1]!);
      if (d < r * 1.5) minR = Math.min(minR, d);
    }
    // 정점은 원 위(안쪽으로 줄지 않음). 변 중점의 현 오차 r(1 − cos(π/n)) ≤ 0.01 은 circularSegments 테스트가 검사
    expect(minR).toBeGreaterThan(r - 1e-4);
  });
});
