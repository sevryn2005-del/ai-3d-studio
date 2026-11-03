import { describe, expect, it } from 'vitest';
import { executeBatch, executeCommand } from './commandExecutor';
import { emptyModel, type ModelDefinition, type Sketch } from './commandTypes';
import { validateGraph } from './modelGraph';
import { constraintResiduals, degreesOfFreedom, polygonError, solveSketch } from './solver';

function run(m: ModelDefinition, cmds: unknown[]): ModelDefinition {
  const r = executeBatch(m, cmds);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

/** 대충 그린 사각형 비슷한 사변형 (꼭짓점 p0..p3, 변 e0..e3) */
function quad(): ModelDefinition {
  return run(emptyModel(), [
    { type: 'create_sketch', id: 'sk' },
    { type: 'add_polygon', sketch: 'sk', id: 'q', points: [[0, 0], [41, 2], [39, 22], [-1, 19]] },
  ]);
}
const sk = (m: ModelDefinition): Sketch => m.sketches[0]!;
const pts = (m: ModelDefinition) => (sk(m).entities[0] as { points: [number, number][] }).points;
const near = (a: number[], b: number[], tol = 1e-5) => a.every((v, i) => Math.abs(v - b[i]!) <= tol);

describe('해석기: 사변형을 40×20 직사각형으로 구속', () => {
  const constraints = [
    { type: 'add_constraint', sketch: 'sk', constraint: 'fix', refs: ['q.p0'] },
    { type: 'add_constraint', sketch: 'sk', constraint: 'horizontal', refs: ['q.e0'] },
    { type: 'add_constraint', sketch: 'sk', constraint: 'vertical', refs: ['q.e1'] },
    { type: 'add_constraint', sketch: 'sk', constraint: 'horizontal', refs: ['q.e2'] },
    { type: 'add_constraint', sketch: 'sk', constraint: 'vertical', refs: ['q.e3'] },
    { type: 'add_constraint', sketch: 'sk', constraint: 'length', refs: ['q.e0'], value: 40 },
    { type: 'add_constraint', sketch: 'sk', constraint: 'length', refs: ['q.e1'], value: 20 },
  ];

  it('구속을 하나씩 더할 때마다 자유도가 줄고, 마지막에 완전 구속 (자유도 0)', () => {
    let m = quad();
    const dofs = [degreesOfFreedom(sk(m))];
    for (const c of constraints) {
      m = run(m, [c]);
      dofs.push(degreesOfFreedom(sk(m)));
    }
    expect(dofs).toEqual([8, 6, 5, 4, 3, 2, 1, 0]); // 점 4개 = 8 → 고정 −2 → 수평·수직 4개 −4 → 길이 2개 −2
    const p = pts(m);
    expect(near(p[0]!, [0, 0])).toBe(true); // 고정점은 그대로
    expect(near(p[1]!, [40, 0])).toBe(true);
    expect(near(p[2]!, [40, 20])).toBe(true);
    expect(near(p[3]!, [0, 20])).toBe(true);
    expect(validateGraph(m)).toEqual([]);
  });

  it('길이 값을 바꾸면 다시 풀린다 (set_constraint)', () => {
    let m = run(quad(), constraints);
    m = run(m, [{ type: 'set_constraint', sketch: 'sk', constraint: 'k6', value: 55 }]);
    expect(near(pts(m)[1]!, [55, 0])).toBe(true);
    expect(near(pts(m)[2]!, [55, 20])).toBe(true);
  });

  it('점을 옮기면 구속을 지키며 따라온다 (move_point), 고정점은 못 옮긴다', () => {
    const m0 = run(quad(), constraints.filter((c) => c.constraint !== 'length'));
    const m = run(m0, [{ type: 'move_point', sketch: 'sk', point: 'q.p2', to: [30, 15] }]);
    const p = pts(m);
    expect(near(p[2]!, [30, 15])).toBe(true); // 옮긴 점은 정확히 그 자리
    expect(near(p[1]!, [30, 0])).toBe(true); // 수직·수평이 유지되며 따라옴
    expect(near(p[3]!, [0, 15])).toBe(true);
    const r = executeCommand(m, { type: 'move_point', sketch: 'sk', point: 'q.p0', to: [5, 5] });
    expect(!r.ok && r.error).toContain('고정되어 있어');
  });

  it('모순되는 구속은 거부하고 원본을 바꾸지 않는다', () => {
    const m = run(quad(), constraints);
    const r = executeCommand(m, { type: 'add_constraint', sketch: 'sk', constraint: 'length', refs: ['q.e2'], value: 30 });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('길이 구속을 추가할 수 없습니다');
    expect(pts(m)[1]).toEqual([40, 0]);
  });
});

describe('해석기: 구속 종류', () => {
  it('평행·직교·같은 길이', () => {
    const m = run(quad(), [
      { type: 'add_constraint', sketch: 'sk', constraint: 'fix', refs: ['q.p0'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'parallel', refs: ['q.e0', 'q.e2'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'perpendicular', refs: ['q.e0', 'q.e1'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'equal', refs: ['q.e0', 'q.e1'] },
    ]);
    expect(Math.max(...constraintResiduals(sk(m)).values())).toBeLessThan(1e-6);
    expect(validateGraph(m)).toEqual([]);
  });

  it('원: 동심·접선·거리 (원 중심을 꼭짓점에서 10mm)', () => {
    const m = run(quad(), [
      { type: 'add_circle', sketch: 'sk', id: 'c1', center: [20, 8], diameter: 10 },
      { type: 'add_circle', sketch: 'sk', id: 'c2', center: [21, 9], diameter: 4 },
      { type: 'add_constraint', sketch: 'sk', constraint: 'fix', refs: ['q.p0'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'horizontal', refs: ['q.e0'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'tangent', refs: ['q.e0', 'c1'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'concentric', refs: ['c1', 'c2'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'distance', refs: ['q.p0', 'c1.center'], value: 13 },
    ]);
    const s = sk(m);
    const c1 = s.entities.find((e) => e.id === 'c1') as { center: [number, number] };
    const c2 = s.entities.find((e) => e.id === 'c2') as { center: [number, number] };
    expect(Math.abs(c1.center[1] - 5)).toBeLessThan(1e-5); // 변(y=0)에 접하는 반지름 5 원 → 중심 y = 5
    expect(Math.hypot(...c1.center)).toBeCloseTo(13, 5);
    expect(near(c1.center, c2.center)).toBe(true);
  });

  it('원 지름을 바꾸면 접선이 유지되도록 다시 풀린다', () => {
    const m0 = run(quad(), [
      { type: 'add_circle', sketch: 'sk', id: 'c1', center: [20, 8], diameter: 10 },
      { type: 'add_constraint', sketch: 'sk', constraint: 'fix', refs: ['q.p0'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'fix', refs: ['q.p1'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'tangent', refs: ['q.e0', 'c1'] },
    ]);
    const m = run(m0, [{ type: 'set_dimension', sketch: 'sk', dimension: 'c1.diameter', value: 16 }]);
    const c1 = sk(m).entities.find((e) => e.id === 'c1') as { center: [number, number] };
    // 변 p0(0,0)-p1(41,2) 까지 거리 = 8
    const [x, y] = c1.center;
    expect(Math.abs(41 * y - 2 * x) / Math.hypot(41, 2)).toBeCloseTo(8, 5);
  });

  it('그린 모양을 최대한 유지한다 (필요한 만큼만 움직임)', () => {
    const m = run(quad(), [
      { type: 'add_circle', sketch: 'sk', id: 'c1', center: [20, 8], diameter: 10 },
      { type: 'add_constraint', sketch: 'sk', constraint: 'fix', refs: ['q.p0'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'horizontal', refs: ['q.e0'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'tangent', refs: ['q.e0', 'c1'] },
    ]);
    const p = pts(m);
    const c1 = sk(m).entities.find((e) => e.id === 'c1') as { center: [number, number] };
    expect(Math.abs(p[1]![0] - 41)).toBeLessThan(0.5); // p1 은 y 만 0 으로
    expect(Math.abs(p[1]![1])).toBeLessThan(1e-5);
    expect(near(p[2]!, [39, 22], 0.5) && near(p[3]!, [-1, 19], 0.5)).toBe(true); // 관련 없는 점은 거의 그대로
    expect(Math.abs(c1.center[0] - 20)).toBeLessThan(0.5);
    expect(Math.abs(c1.center[1] - 5)).toBeLessThan(1e-5);
  });

  it('잘못된 참조는 거부', () => {
    const m = quad();
    for (const [cmd, msg] of [
      [{ constraint: 'length', refs: ['q.p0'], value: 3 }, '길이 구속은 변 를 참조해야'],
      [{ constraint: 'length', refs: ['q.e0'] }, '값(mm)이 필요합니다'],
      [{ constraint: 'horizontal', refs: ['q.e9'] }, '없는 점·변·원'],
      [{ constraint: 'coincident', refs: ['q.p0', 'q.p0'] }, '같은 대상을 두 번'],
    ] as const) {
      const r = executeCommand(m, { type: 'add_constraint', sketch: 'sk', ...cmd });
      expect(!r.ok && r.error).toContain(msg);
    }
  });

  it('요소를 지우면 그 요소를 참조하던 구속도 지워진다', () => {
    const m = run(quad(), [
      { type: 'add_circle', sketch: 'sk', id: 'c1', diameter: 4 },
      { type: 'add_constraint', sketch: 'sk', constraint: 'distance', refs: ['q.p0', 'c1.center'], value: 5 },
      { type: 'add_constraint', sketch: 'sk', constraint: 'horizontal', refs: ['q.e0'] },
      { type: 'delete_sketch_entity', sketch: 'sk', entity: 'c1' },
    ]);
    expect(sk(m).constraints.map((c) => c.type)).toEqual(['horizontal']);
  });
});

describe('다각형 형상', () => {
  it('꼬인 다각형·넓이 0 거부', () => {
    expect(polygonError([[0, 0], [10, 10], [10, 0], [0, 10]])).toContain('교차');
    expect(polygonError([[0, 0], [5, 0], [10, 0]])).toContain('넓이가 0');
    expect(polygonError([[0, 0], [10, 0], [5, 8]])).toBeNull();
    const r = executeCommand(run(emptyModel(), [{ type: 'create_sketch', id: 'sk' }]), {
      type: 'add_polygon', sketch: 'sk', points: [[0, 0], [10, 10], [10, 0], [0, 10]],
    });
    expect(!r.ok && r.error).toContain('교차');
  });

  it('구속을 풀다 다각형이 꼬이면 거부', () => {
    // 삼각형 한 변 길이를 다른 두 변 합보다 길게 → 꼬이거나 풀 수 없음
    const m = run(emptyModel(), [
      { type: 'create_sketch', id: 'sk' },
      { type: 'add_polygon', sketch: 'sk', id: 't', points: [[0, 0], [10, 0], [5, 5]] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'length', refs: ['t.e1'], value: 7 },
      { type: 'add_constraint', sketch: 'sk', constraint: 'length', refs: ['t.e2'], value: 7 },
      { type: 'add_constraint', sketch: 'sk', constraint: 'fix', refs: ['t.p0'] },
      { type: 'add_constraint', sketch: 'sk', constraint: 'fix', refs: ['t.p1'] },
    ]);
    const r = executeCommand(m, { type: 'set_constraint', sketch: 'sk', constraint: 'k1', value: 2 });
    expect(r.ok).toBe(false);
  });

  it('구속 없는 스케치는 그대로', () => {
    const s = sk(quad());
    const r = solveSketch(s);
    expect(r.ok && r.sketch.entities).toEqual(s.entities);
  });
});
