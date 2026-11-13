/**
 * 요소 변환 (솔리드웍스 Convert Entities) — 순수 함수: 고른 면의 경계(바깥 윤곽 + 구멍)를 스케치 요소 명령으로.
 *
 * 1. 면 삼각형 메시에서 한 삼각형에만 속한 변 = 경계 변 → 이어서 닫힌 고리들 (위치 1e-5mm 격자로 같은 점 판별).
 * 2. 고리를 스케치 평면 좌표로 (world → sketch 역행렬, 평면에 수직 성분은 버림 = 평면에 투영).
 * 3. 원 판별: 점 12개 이상이 중심에서 같은 거리(0.5% 이내) → 원 요소 (지름). 아니면 다각형:
 *    한 직선 위 점 빼기 → 점이 많으면(64개 한도) 허용 오차를 키워 가며 줄이기 (Douglas–Peucker).
 * 4. 넓이가 가장 큰 고리 = 바깥 윤곽, 나머지 = 구멍. 구멍이 있으면 영역(바깥 − 구멍)을 만들어 그 영역을 돌출 단면으로.
 * 결과는 보통 스케치 명령(add_polygon·add_circle·add_region) — 실행 취소·AI·저장 형식 그대로.
 */
import { Matrix4, Vector3 } from 'three';
import type { CadCommand, ObjectId, Point2, Sketch } from './commandTypes';
import { LIMITS } from './commandTypes';
import { polygonError, signedArea } from './solver';

const KEY = 1e5;
const key = (x: number, y: number, z: number) => `${Math.round(x * KEY)},${Math.round(y * KEY)},${Math.round(z * KEY)}`;

/** 면 메시의 경계 고리들 (월드 좌표) */
export function faceLoops(positions: ArrayLike<number>, indices: ArrayLike<number>): Vector3[][] {
  const vk = (i: number) => key(positions[i * 3]!, positions[i * 3 + 1]!, positions[i * 3 + 2]!);
  const pt = new Map<string, Vector3>();
  const count = new Map<string, number>();
  const dirEdges: [string, string][] = [];
  for (let t = 0; t + 2 < indices.length; t += 3) {
    const ks = [0, 1, 2].map((k) => {
      const i = indices[t + k]!;
      const s = vk(i);
      if (!pt.has(s)) pt.set(s, new Vector3(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
      return s;
    });
    for (let k = 0; k < 3; k++) {
      const a = ks[k]!;
      const b = ks[(k + 1) % 3]!;
      if (a === b) continue;
      const u = a < b ? `${a}|${b}` : `${b}|${a}`;
      count.set(u, (count.get(u) ?? 0) + 1);
      dirEdges.push([a, b]);
    }
  }
  // 경계 변 (방향 유지: 삼각형 감김 방향 → 바깥 고리는 반시계, 구멍은 시계)
  const next = new Map<string, string[]>();
  for (const [a, b] of dirEdges) {
    if (count.get(a < b ? `${a}|${b}` : `${b}|${a}`) !== 1) continue;
    next.set(a, [...(next.get(a) ?? []), b]);
  }
  const loops: Vector3[][] = [];
  const used = new Set<string>();
  for (const start of next.keys()) {
    if (used.has(start)) continue;
    const loop: string[] = [];
    let cur: string | undefined = start;
    while (cur && !used.has(cur)) {
      used.add(cur);
      loop.push(cur);
      cur = next.get(cur)?.find((n) => !used.has(n) || n === start);
      if (cur === start) break;
    }
    if (loop.length >= 3) loops.push(loop.map((s) => pt.get(s)!));
  }
  return loops;
}

/** 같은 직선 위 점 빼기 */
function dropCollinear(p: Point2[], tol: number): Point2[] {
  if (p.length <= 3) return p;
  const out: Point2[] = [];
  for (let i = 0; i < p.length; i++) {
    const a = p[(i - 1 + p.length) % p.length]!;
    const b = p[i]!;
    const c = p[(i + 1) % p.length]!;
    const len = Math.hypot(c[0] - a[0], c[1] - a[1]);
    const d = len > 1e-12 ? Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / len : 0;
    if (d > tol) out.push(b);
  }
  return out.length >= 3 ? out : p;
}

/** 닫힌 꺾은선 줄이기 (Douglas–Peucker, 가장 먼 두 점으로 나눠서) */
function simplifyClosed(p: Point2[], tol: number): Point2[] {
  if (p.length <= 4) return p;
  const seg = (pts: Point2[]): Point2[] => {
    if (pts.length <= 2) return pts;
    const a = pts[0]!;
    const b = pts[pts.length - 1]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1e-12;
    let best = 0;
    let at = 0;
    for (let i = 1; i < pts.length - 1; i++) {
      const q = pts[i]!;
      const d = Math.abs((q[0] - a[0]) * (b[1] - a[1]) - (q[1] - a[1]) * (b[0] - a[0])) / len;
      if (d > best) [best, at] = [d, i];
    }
    if (best <= tol) return [a, b];
    const l = seg(pts.slice(0, at + 1));
    return [...l.slice(0, -1), ...seg(pts.slice(at))];
  };
  let far = 0;
  let fd = 0;
  for (let i = 1; i < p.length; i++) {
    const d = Math.hypot(p[i]![0] - p[0]![0], p[i]![1] - p[0]![1]);
    if (d > fd) [fd, far] = [d, i];
  }
  const first = seg(p.slice(0, far + 1));
  const second = seg([...p.slice(far), p[0]!]);
  return [...first.slice(0, -1), ...second.slice(0, -1)];
}

export type OutlineShape = { type: 'circle'; center: Point2; diameter: number } | { type: 'polygon'; points: Point2[] };

const r4 = (v: number) => Math.round(v * 1e4) / 1e4 + 0;

/** 2D 고리 → 원 또는 다각형 (반시계, 64점 이하) */
export function loopShape(loop: Point2[]): OutlineShape | null {
  if (loop.length < 3) return null;
  const n = loop.length;
  const cx = loop.reduce((s, q) => s + q[0], 0) / n;
  const cy = loop.reduce((s, q) => s + q[1], 0) / n;
  const rs = loop.map((q) => Math.hypot(q[0] - cx, q[1] - cy));
  const r = rs.reduce((s, v) => s + v, 0) / n;
  if (n >= 12 && r > 0 && rs.every((v) => Math.abs(v - r) <= r * 0.005 + 1e-4)) {
    // 다각형 근사의 평균 반지름은 조금 작다 → 꼭짓점(외접) 반지름을 쓴다
    return { type: 'circle', center: [r4(cx), r4(cy)], diameter: r4(2 * Math.max(...rs)) };
  }
  let pts = loop.map(([x, y]) => [r4(x), r4(y)] as Point2);
  if (signedArea(pts) < 0) pts.reverse();
  pts = dropCollinear(pts, 1e-4);
  let tol = 1e-3;
  while (pts.length > LIMITS.maxPolygonPoints && tol < 10) {
    pts = simplifyClosed(pts, tol);
    tol *= 2;
  }
  if (pts.length > LIMITS.maxPolygonPoints || polygonError(pts)) return null;
  return { type: 'polygon', points: pts };
}

/** 월드 고리들 → 스케치 평면 2D (sketchWorld = 스케치 좌표 → 월드) */
export function projectLoops(loops: Vector3[][], sketchWorld: Matrix4): Point2[][] {
  const inv = sketchWorld.clone().invert();
  return loops.map((l) => l.map((p) => {
    const q = p.clone().applyMatrix4(inv);
    return [q.x, q.y] as Point2;
  }));
}

function freeIds(sketch: Sketch, prefix: string, n: number): ObjectId[] {
  const taken = new Set(sketch.entities.map((e) => e.id));
  const out: ObjectId[] = [];
  for (let k = 1; out.length < n; k++) {
    const id = `${prefix}${k}`;
    if (!taken.has(id)) out.push(id);
  }
  return out;
}

export type ConvertResult = { ok: true; commands: CadCommand[]; profile: ObjectId; holes: number } | { ok: false; error: string };

/** 고른 면의 고리들(스케치 2D) → 스케치 명령 + 돌출할 단면 ID */
export function convertCommands(sketch: Sketch, loops2d: Point2[][]): ConvertResult {
  const shapes = loops2d
    .map((l) => ({ l, area: Math.abs(signedArea(l)) }))
    .filter((s) => s.area > 1e-6)
    .sort((a, b) => b.area - a.area)
    .map((s) => loopShape(s.l));
  if (!shapes.length || !shapes[0]) return { ok: false, error: '고른 면의 윤곽을 스케치로 옮길 수 없습니다 (꼬였거나 너무 복잡한 경계)' };
  const valid = shapes.filter((s): s is OutlineShape => !!s);
  if (sketch.entities.length + valid.length + (valid.length > 1 ? 1 : 0) > LIMITS.maxSketchEntities)
    return { ok: false, error: `스케치 요소는 최대 ${LIMITS.maxSketchEntities}개입니다 — 새 스케치에서 해 보세요` };
  const ids = freeIds(sketch, 'cv', valid.length + 1);
  const commands: CadCommand[] = valid.map((s, i) =>
    s.type === 'circle'
      ? { type: 'add_circle', sketch: sketch.id, id: ids[i]!, center: s.center, diameter: s.diameter }
      : { type: 'add_polygon', sketch: sketch.id, id: ids[i]!, points: s.points },
  );
  let profile = ids[0]!;
  if (valid.length > 1) {
    profile = ids[valid.length]!;
    commands.push({ type: 'add_region', sketch: sketch.id, id: profile, items: valid.map((_, i) => ({ entity: ids[i]!, op: i === 0 ? 'add' : 'subtract' })) });
  }
  return { ok: true, commands, profile, holes: valid.length - 1 };
}
