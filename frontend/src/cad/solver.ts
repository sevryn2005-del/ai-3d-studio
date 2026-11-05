/**
 * 2D 스케치 구속 해석기 (자체 구현, docs/review-constraint-solver.md 5장 1단계).
 *
 * - 변수: 다각형 꼭짓점, 사각형·원의 중심 (각 x, y). `fix` 구속이 걸린 점과 이번 편집에서 사용자가 옮긴 점(pinned)은 상수.
 * - 각 구속은 잔차(0 이면 만족) 식으로 표현하고, 레벤버그-마쿼트로 현재 좌표에서 가장 적게 움직이는 해를 찾는다.
 * - 해석기는 편집할 때(프론트엔드 실행기)만 돈다. 결과 좌표를 설계 원본에 저장하므로 CAD 엔진은 좌표만 읽는다.
 *   백엔드는 같은 잔차 식(app/cad/constraints.py)으로 저장된 좌표가 구속을 만족하는지만 검사한다.
 * 순수 함수: 입력을 바꾸지 않는다.
 */
import type { ConstraintType, Point2, Sketch, SketchConstraint, SketchEntity } from './commandTypes';

/** 해가 만족해야 하는 잔차 (mm, 무차원 각도 잔차 포함) */
export const SOLVE_TOLERANCE = 1e-9;
/** 저장된 좌표(소수 6자리 반올림)가 만족해야 하는 잔차 — 백엔드 검사와 같은 값 */
export const CHECK_TOLERANCE = 1e-4;

export const CONSTRAINT_LABEL: Record<ConstraintType, string> = {
  fix: '고정',
  coincident: '일치',
  concentric: '동심',
  horizontal: '수평',
  vertical: '수직',
  parallel: '평행',
  perpendicular: '직교',
  equal: '같은 길이',
  length: '길이',
  distance: '거리',
  tangent: '접선',
  angle: '각도',
};

type RefKind = 'point' | 'edge' | 'circle';

/** 구속 종류별 참조 형식 (단일 출처: 프론트 실행기·AI 검증기 문서·백엔드 constraints.py 가 같은 표) */
export const CONSTRAINT_ARITY: Record<ConstraintType, { refs: RefKind[][]; value: boolean }> = {
  fix: { refs: [['point']], value: false },
  coincident: { refs: [['point', 'point']], value: false },
  concentric: { refs: [['circle', 'circle']], value: false },
  horizontal: { refs: [['edge'], ['point', 'point']], value: false },
  vertical: { refs: [['edge'], ['point', 'point']], value: false },
  parallel: { refs: [['edge', 'edge']], value: false },
  perpendicular: { refs: [['edge', 'edge']], value: false },
  equal: { refs: [['edge', 'edge']], value: false },
  length: { refs: [['edge']], value: true },
  distance: { refs: [['point', 'point']], value: true },
  tangent: { refs: [['edge', 'circle']], value: false },
  angle: { refs: [['edge', 'edge']], value: true },
};

// ---- 참조 해석 ---------------------------------------------------------------

/** 스케치의 모든 점 이름 → 좌표 (다각형 꼭짓점, 사각형·원 중심) */
export function sketchPoints(sketch: Sketch): Map<string, Point2> {
  const pts = new Map<string, Point2>();
  for (const e of sketch.entities) {
    if (e.type === 'polygon' || e.type === 'line' || e.type === 'path') e.points.forEach((p, k) => pts.set(`${e.id}.p${k}`, p));
    else pts.set(`${e.id}.center`, e.center);
  }
  return pts;
}

function entityOf(sketch: Sketch, ref: string): SketchEntity | undefined {
  return sketch.entities.find((e) => e.id === ref.split('.')[0]);
}

/** 참조 종류. 없는 참조면 null */
export function refKind(sketch: Sketch, ref: string): RefKind | null {
  const e = entityOf(sketch, ref);
  if (!e) return null;
  const [, part] = ref.split('.');
  if (part === undefined) return e.type === 'circle' ? 'circle' : null;
  if (part === 'center') return e.type === 'polygon' || e.type === 'line' || e.type === 'path' ? null : 'point';
  if (e.type !== 'polygon' && e.type !== 'line' && e.type !== 'path') return null;
  const k = Number(part.slice(1));
  // 다각형: 꼭짓점 수만큼 변 (닫힘). 구성선·경로: 열린 선 → 변 = 점 수 − 1
  if (k >= (part[0] === 'e' && e.type !== 'polygon' ? e.points.length - 1 : e.points.length)) return null;
  return part[0] === 'p' ? 'point' : 'edge';
}

/** 변 → 두 끝점 이름 */
function edgeEnds(sketch: Sketch, ref: string): [string, string] {
  const [id, part] = ref.split('.') as [string, string];
  const e = entityOf(sketch, ref) as Extract<SketchEntity, { type: 'polygon' | 'line' | 'path' }>;
  const k = Number(part.slice(1));
  return [`${id}.p${k}`, `${id}.p${(k + 1) % e.points.length}`];
}

function circleRadius(sketch: Sketch, id: string): number {
  return (sketch.dimensions.find((d) => d.entity === id && d.kind === 'diameter')?.value ?? 0) / 2;
}

/** 구속이 참조 형식에 맞는지. 맞으면 null, 아니면 사용자용 메시지 */
export function constraintError(sketch: Sketch, c: Pick<SketchConstraint, 'type' | 'refs' | 'value'>): string | null {
  const spec = CONSTRAINT_ARITY[c.type];
  const kinds = c.refs.map((r) => refKind(sketch, r));
  const missing = c.refs.find((_, i) => kinds[i] === null);
  if (missing) return `없는 점·변·원을 참조합니다: ${missing}`;
  if (!spec.refs.some((form) => form.length === kinds.length && form.every((k, i) => k === kinds[i]))) {
    const forms = spec.refs.map((f) => f.map((k) => ({ point: '점', edge: '변', circle: '원' })[k]).join(' + ')).join(' 또는 ');
    return `${CONSTRAINT_LABEL[c.type]} 구속은 ${forms} 를 참조해야 합니다`;
  }
  if (spec.value && c.value === undefined) return `${CONSTRAINT_LABEL[c.type]} 구속에는 값(mm)이 필요합니다`;
  if (!spec.value && c.value !== undefined) return `${CONSTRAINT_LABEL[c.type]} 구속에는 값을 넣지 않습니다`;
  if (c.refs.length === 2 && c.refs[0] === c.refs[1]) return '같은 대상을 두 번 참조할 수 없습니다';
  if (c.type === 'angle' && (c.value! <= 0 || c.value! >= 180)) return '각도는 0° 보다 크고 180° 보다 작아야 합니다';
  return null;
}

// ---- 잔차 -------------------------------------------------------------------

type Get = (name: string) => Point2;

/** 구속 하나의 잔차 (만족하면 모두 0). fix 는 변수에서 빠지므로 잔차가 없다 */
function residuals(sketch: Sketch, c: SketchConstraint, get: Get): number[] {
  const P = (ref: string) => get(ref.endsWith('.center') || ref.includes('.p') ? ref : `${ref}.center`);
  const dir = (edge: string): Point2 => {
    const [a, b] = edgeEnds(sketch, edge).map(get) as [Point2, Point2];
    return [b[0] - a[0], b[1] - a[1]];
  };
  const len = (v: Point2) => Math.hypot(v[0], v[1]);
  const kinds = c.refs.map((r) => refKind(sketch, r));
  const pair = (): [Point2, Point2] =>
    kinds[0] === 'edge' ? (edgeEnds(sketch, c.refs[0]!).map(get) as [Point2, Point2]) : [P(c.refs[0]!), P(c.refs[1]!)];
  switch (c.type) {
    case 'fix':
      return [];
    case 'coincident':
    case 'concentric': {
      const a = P(c.refs[0]!);
      const b = P(c.refs[1]!);
      return [b[0] - a[0], b[1] - a[1]];
    }
    case 'horizontal': {
      const [a, b] = pair();
      return [b[1] - a[1]];
    }
    case 'vertical': {
      const [a, b] = pair();
      return [b[0] - a[0]];
    }
    case 'parallel':
    case 'perpendicular': {
      const u = dir(c.refs[0]!);
      const v = dir(c.refs[1]!);
      const n = Math.max(len(u) * len(v), 1e-12);
      return [c.type === 'parallel' ? (u[0] * v[1] - u[1] * v[0]) / n : (u[0] * v[0] + u[1] * v[1]) / n];
    }
    case 'equal':
      return [len(dir(c.refs[0]!)) - len(dir(c.refs[1]!))];
    case 'length':
      return [len(dir(c.refs[0]!)) - c.value!];
    case 'distance': {
      const a = P(c.refs[0]!);
      const b = P(c.refs[1]!);
      return [Math.hypot(b[0] - a[0], b[1] - a[1]) - c.value!];
    }
    case 'angle': {
      // 첫 변 → 둘째 변 반시계 각 θ: (u×v)cosθ − (u·v)sinθ = 0 (길이로 나눠 무차원). θ 와 θ+180° 는 같은 직선 쌍
      const u = dir(c.refs[0]!);
      const v = dir(c.refs[1]!);
      const n = Math.max(len(u) * len(v), 1e-12);
      const t = (c.value! * Math.PI) / 180;
      return [((u[0] * v[1] - u[1] * v[0]) * Math.cos(t) - (u[0] * v[0] + u[1] * v[1]) * Math.sin(t)) / n];
    }
    case 'tangent': {
      const [a, b] = edgeEnds(sketch, c.refs[0]!).map(get) as [Point2, Point2];
      const o = P(c.refs[1]!);
      const d: Point2 = [b[0] - a[0], b[1] - a[1]];
      const dist = Math.abs(d[0] * (o[1] - a[1]) - d[1] * (o[0] - a[0])) / Math.max(len(d), 1e-12);
      return [dist - circleRadius(sketch, c.refs[1]!)];
    }
  }
}

/** 고정된 점 이름 */
function fixedPoints(sketch: Sketch): Set<string> {
  const s = new Set<string>();
  for (const c of sketch.constraints) if (c.type === 'fix') s.add(c.refs[0]!);
  return s;
}

/** 저장된 좌표 기준 구속별 최대 잔차 (검증·표시용) */
export function constraintResiduals(sketch: Sketch): Map<string, number> {
  const pts = sketchPoints(sketch);
  const out = new Map<string, number>();
  for (const c of sketch.constraints) {
    if (constraintError(sketch, c)) continue;
    const r = residuals(sketch, c, (n) => pts.get(n)!);
    out.set(c.id, Math.max(0, ...r.map(Math.abs)));
  }
  return out;
}

// ---- 해석 -------------------------------------------------------------------

/** 진단에 쓰는 구속 수 상한 (구속마다 해석을 한 번 더 하므로) */
const MAX_DIAGNOSE = 40;

/**
 * 풀리지 않을 때 "어느 구속끼리 충돌하는지" 찾는다 (SolidWorks SketchXpert 의 진단과 같은 목적):
 * 그 구속 하나만 빼면 풀리는 구속들 = 충돌에 관여한 구속. 하나만 빼서는 안 풀리면 빈 목록.
 */
export function conflictingConstraints(sketch: Sketch, pinned: ReadonlySet<string> = new Set()): SketchConstraint[] {
  if (sketch.constraints.length > MAX_DIAGNOSE) return [];
  return sketch.constraints.filter(
    (c) => solveSketch({ ...sketch, constraints: sketch.constraints.filter((o) => o !== c) }, pinned, false).ok,
  );
}

export type SolveResult = { ok: true; sketch: Sketch; dof: number } | { ok: false; error: string };

/**
 * 구속을 만족하도록 점을 옮긴다. pinned: 이번 편집에서 사용자가 정한 점(움직이지 않음).
 * 풀 수 없으면 ok:false — 실행기는 이 경우 명령을 거부하고 원본을 그대로 둔다.
 */
export function solveSketch(sketch: Sketch, pinned: ReadonlySet<string> = new Set(), diagnose = true): SolveResult {
  for (const c of sketch.constraints) {
    const err = constraintError(sketch, c);
    if (err) return { ok: false, error: `구속 ${c.id}: ${err}` };
  }
  const pts = sketchPoints(sketch);
  const fixed = fixedPoints(sketch);
  const free = [...pts.keys()].filter((n) => !fixed.has(n) && !pinned.has(n));
  const slot = new Map(free.map((n, i) => [n, i]));
  const x0 = free.flatMap((n) => [...pts.get(n)!]);
  const active = sketch.constraints.filter((c) => c.type !== 'fix');

  const getter = (x: number[]): Get => (n) => {
    const i = slot.get(n);
    return i === undefined ? pts.get(n)! : [x[2 * i]!, x[2 * i + 1]!];
  };
  const R = (x: number[]) => active.flatMap((c) => residuals(sketch, c, getter(x)));

  const attempt = (start: number[]) => minimalMoveSolve(R, start);
  let x = x0;
  let r = R(x);
  if (r.length && maxAbs(r) > SOLVE_TOLERANCE) {
    if (!x.length) return { ok: false, error: '고정된 점끼리의 구속을 만족할 수 없습니다' };
    let best = attempt(x0);
    // 두 점이 같은 자리에서 시작하면(거리 구속 등) 기울기가 0 → 아주 조금 흔들어 다시 시도
    if (maxAbs(best.r) > SOLVE_TOLERANCE) {
      const jittered = x0.map((v, i) => v + 1e-3 * (((i * 7919) % 13) - 6));
      const second = attempt(jittered);
      if (maxAbs(second.r) < maxAbs(best.r)) best = second;
    }
    x = best.x;
    r = best.r;
    if (maxAbs(r) > SOLVE_TOLERANCE * 1e3) {
      const culprits = diagnose ? conflictingConstraints(sketch, pinned) : [];
      const named = culprits.map((c) => `${CONSTRAINT_LABEL[c.type]} ${c.id}`).join(', ');
      return {
        ok: false,
        error: culprits.length
          ? `구속을 동시에 만족할 수 없습니다 — 서로 충돌하는 구속: ${named}. 이 중 하나를 지우거나 값을 바꾸세요`
          : '구속을 동시에 만족할 수 없습니다 (서로 모순되거나 과하게 구속되었습니다)',
      };
    }
  }

  // 좌표 반영 (소수 6자리로 반올림해 저장 → 백엔드 검사와 같은 허용 오차)
  const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
  const get = getter(x);
  const entities = sketch.entities.map((e): SketchEntity => {
    if (e.type === 'polygon' || e.type === 'path') return { ...e, points: e.points.map((_, k) => get(`${e.id}.p${k}`).map(round) as Point2) };
    if (e.type === 'line') return { ...e, points: [get(`${e.id}.p0`).map(round) as Point2, get(`${e.id}.p1`).map(round) as Point2] };
    return { ...e, center: get(`${e.id}.center`).map(round) as Point2 };
  });
  const solved: Sketch = { ...sketch, entities };
  const worst = Math.max(0, ...constraintResiduals(solved).values());
  if (worst > CHECK_TOLERANCE) return { ok: false, error: '구속을 동시에 만족할 수 없습니다' };
  return { ok: true, sketch: solved, dof: degreesOfFreedom(solved) };
}

/** 남은 자유도 = 자유 좌표 수 − 구속 자코비안의 계수(rank). 0 이면 완전 구속 */
export function degreesOfFreedom(sketch: Sketch): number {
  const pts = sketchPoints(sketch);
  const fixed = fixedPoints(sketch);
  const free = [...pts.keys()].filter((n) => !fixed.has(n));
  if (!free.length) return 0;
  const slot = new Map(free.map((n, i) => [n, i]));
  const x = free.flatMap((n) => [...pts.get(n)!]);
  const active = sketch.constraints.filter((c) => c.type !== 'fix' && !constraintError(sketch, c));
  const R = (xs: number[]) =>
    active.flatMap((c) =>
      residuals(sketch, c, (n) => {
        const i = slot.get(n);
        return i === undefined ? pts.get(n)! : [xs[2 * i]!, xs[2 * i + 1]!];
      }),
    );
  const m = R(x).length;
  return x.length - (m ? rank(jacobian(R, x, m)) : 0);
}

// ---- 수치 계산 (작은 밀집 행렬) -----------------------------------------------

/**
 * 최소 이동 감쇠 가우스-뉴턴: Δ = −Jᵀ (J Jᵀ + λI)⁻¹ r.
 * 구속이 모자란(자유도가 남은) 스케치에서 현재 좌표에서 가장 적게 움직이는 해 쪽으로 간다 → 사용자가 그린 모양을 최대한 유지.
 * λ 는 비용이 줄면 작게, 늘면 크게 (레벤버그-마쿼트 방식).
 */
export function minimalMoveSolve(R: (x: number[]) => number[], x0: number[]): { x: number[]; r: number[] } {
  let x = x0;
  let r = R(x);
  let cost = sumSq(r);
  let lambda = 1e-6;
  for (let it = 0; it < 300 && maxAbs(r) > SOLVE_TOLERANCE; it++) {
    const J = jacobian(R, x, r.length);
    const m = r.length;
    const JJt = Array.from({ length: m }, (_, i) => Array.from({ length: m }, (_, j) => J[i]!.reduce((s, v, k) => s + v * J[j]![k]!, 0)));
    let improved = false;
    while (lambda < 1e8) {
      const y = solveLinear(JJt.map((row, i) => row.map((v, j) => (i === j ? v + lambda : v))), r);
      if (!y) {
        lambda *= 10;
        continue;
      }
      const step = x.map((_, k) => -J.reduce((s, row, i) => s + row[k]! * y[i]!, 0));
      const xn = x.map((v, k) => v + step[k]!);
      const rn = R(xn);
      const cn = sumSq(rn);
      if (cn < cost) {
        x = xn;
        r = rn;
        cost = cn;
        lambda = Math.max(lambda / 10, 1e-12);
        improved = true;
        break;
      }
      lambda *= 10;
    }
    if (!improved) break;
  }
  return { x, r };
}

const maxAbs = (v: number[]) => v.reduce((m, a) => Math.max(m, Math.abs(a)), 0);
const sumSq = (v: number[]) => v.reduce((s, a) => s + a * a, 0);

export function jacobian(R: (x: number[]) => number[], x: number[], m: number): number[][] {
  const J = Array.from({ length: m }, () => new Array<number>(x.length).fill(0));
  for (let j = 0; j < x.length; j++) {
    const h = 1e-6 * Math.max(1, Math.abs(x[j]!));
    const xp = x.slice();
    const xm = x.slice();
    xp[j]! += h;
    xm[j]! -= h;
    const rp = R(xp);
    const rm = R(xm);
    for (let i = 0; i < m; i++) J[i]![j] = (rp[i]! - rm[i]!) / (2 * h);
  }
  return J;
}

/** 가우스 소거 (부분 피벗). 특이 행렬이면 null */
function solveLinear(A: number[][], b: number[]): number[] | null {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]!]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-15) return null;
    [M[c], M[p]] = [M[p]!, M[c]!];
    for (let r = c + 1; r < n; r++) {
      const f = M[r]![c]! / M[c]![c]!;
      for (let k = c; k <= n; k++) M[r]![k]! -= f * M[c]![k]!;
    }
  }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let s = M[r]![n]!;
    for (let k = r + 1; k < n; k++) s -= M[r]![k]! * x[k]!;
    x[r] = s / M[r]![r]!;
  }
  return x;
}

/** 행렬 계수 (가우스 소거, 상대 허용 오차) */
export function rank(J: number[][]): number {
  const M = J.map((row) => row.slice());
  const rows = M.length;
  const cols = M[0]?.length ?? 0;
  const scale = Math.max(1e-12, ...M.flat().map(Math.abs));
  let rk = 0;
  for (let c = 0; c < cols && rk < rows; c++) {
    let p = rk;
    for (let r = rk + 1; r < rows; r++) if (Math.abs(M[r]![c]!) > Math.abs(M[p]![c]!)) p = r;
    if (Math.abs(M[p]![c]!) < 1e-7 * scale) continue;
    [M[rk], M[p]] = [M[p]!, M[rk]!];
    for (let r = rk + 1; r < rows; r++) {
      const f = M[r]![c]! / M[rk]![c]!;
      for (let k = c; k < cols; k++) M[r]![k]! -= f * M[rk]![k]!;
    }
    rk++;
  }
  return rk;
}

// ---- 다각형 형상 검사 ----------------------------------------------------------

/**
 * 변의 최소 길이 (mm) = 출력 허용 오차. 이보다 짧은 변은 눈에 보이지 않는 틈·중복 점이라
 * 다른 CAD 에서 "열린 윤곽"·미세 모서리 실패의 흔한 원인이 된다 (docs/issue-survey.md 2-4, 4-6).
 * 백엔드 constraints.MIN_EDGE 와 같은 값.
 */
export const MIN_EDGE = 0.01;

/** 다각형이 단순(변끼리 교차하지 않음)하고 넓이가 있는지. 문제가 없으면 null */
export function polygonError(points: Point2[]): string | null {
  const n = points.length;
  for (let i = 0; i < n; i++) {
    const a = points[i]!;
    const b = points[(i + 1) % n]!;
    if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_EDGE)
      return `변 e${i} 이(가) 너무 짧습니다 (${MIN_EDGE}mm 미만 — 거의 같은 점 두 개). 점 p${i} 또는 p${(i + 1) % n} 을 옮기거나 지우세요`;
    for (let j = i + 1; j < n; j++) {
      if (j === i || (j + 1) % n === i || (i + 1) % n === j) continue; // 이웃한 변
      if (segmentsCross(a, b, points[j]!, points[(j + 1) % n]!)) return `변 e${i} 와 e${j} 가 교차합니다 (꼬인 다각형)`;
    }
  }
  if (Math.abs(signedArea(points)) < 1e-6) return '다각형의 넓이가 0 입니다';
  return null;
}

export function signedArea(points: Point2[]): number {
  let s = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    s += x1 * y2 - x2 * y1;
  }
  return s / 2;
}

function segmentsCross(p1: Point2, p2: Point2, p3: Point2, p4: Point2): boolean {
  const o = (a: Point2, b: Point2, c: Point2) => (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
  const d1 = o(p3, p4, p1);
  const d2 = o(p3, p4, p2);
  const d3 = o(p1, p2, p3);
  const d4 = o(p1, p2, p4);
  return ((d1 > 1e-12 && d2 < -1e-12) || (d1 < -1e-12 && d2 > 1e-12)) && ((d3 > 1e-12 && d4 < -1e-12) || (d3 < -1e-12 && d4 > 1e-12));
}
