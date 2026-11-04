/**
 * 로프트·헬릭스의 단면 점 (형식 v8). 두 엔진이 같은 규칙으로 같은 점을 만든다 — 서버 app/cad/sections.py.
 *
 * outline(p): 프로파일 윤곽 (스케치 평면 u·v, 반시계). 원은 정밀 다각형(256), 슬롯은 반원당 64.
 * resample(points, n): 둘레를 n 등분한 점. 시작 = 바운딩 박스 중심에서 +u 방향 반직선과 윤곽이 처음 만나는 점.
 * 로프트는 단면마다 같은 n 으로 다시 나눠 점끼리 잇는다.
 */
import type { Point2 } from './commandTypes';
import { profileBounds, slotOutline, type Profile } from './sketch';

export function outline(p: Profile): Point2[] {
  let pts: Point2[];
  if (p.type === 'polygon') pts = p.points.map((q) => [q[0], q[1]]);
  else if (p.type === 'rectangle') {
    const [cx, cy] = p.center;
    const [w, h] = [p.width / 2, p.height / 2];
    pts = [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]];
  } else if (p.type === 'slot') pts = slotOutline(p, 64);
  else {
    const r = p.diameter / 2;
    pts = Array.from({ length: 256 }, (_, k) => [p.center[0] + r * Math.cos((2 * Math.PI * k) / 256), p.center[1] + r * Math.sin((2 * Math.PI * k) / 256)] as Point2);
  }
  return signedArea(pts) < 0 ? pts.reverse() : pts;
}

export function signedArea(pts: Point2[]): number {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i]!;
    const q = pts[(i + 1) % pts.length]!;
    a += p[0] * q[1] - q[0] * p[1];
  }
  return a / 2;
}

export function resample(pts: Point2[], n: number, center: Point2): Point2[] {
  // 시작점: center 에서 +u 방향 반직선과 처음 만나는 변 (가장 가까운 교점)
  let start = { edge: 0, t: 0, dist: Infinity };
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const dy = b[1] - a[1];
    if (Math.abs(dy) < 1e-12) continue;
    const t = (center[1] - a[1]) / dy;
    if (t < 0 || t >= 1) continue;
    const x = a[0] + t * (b[0] - a[0]);
    const d = x - center[0];
    if (d > 1e-12 && d < start.dist) start = { edge: i, t, dist: d };
  }
  // 시작점부터 한 바퀴 도는 점 열 (시작점 + 그 뒤 꼭짓점들 + 다시 시작점)
  const s0 = pts[start.edge]!;
  const s1 = pts[(start.edge + 1) % pts.length]!;
  const sp: Point2 = [s0[0] + start.t * (s1[0] - s0[0]), s0[1] + start.t * (s1[1] - s0[1])];
  const ring: Point2[] = [sp];
  for (let k = 1; k <= pts.length; k++) ring.push(pts[(start.edge + k) % pts.length]!);
  ring.push(sp);
  const seg = ring.slice(0, -1).map((p, i) => Math.hypot(ring[i + 1]![0] - p[0], ring[i + 1]![1] - p[1]));
  const total = seg.reduce((s, v) => s + v, 0);
  const out: Point2[] = [];
  let i = 0;
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const target = (total * k) / n;
    while (i < seg.length - 1 && acc + seg[i]! < target - 1e-12) acc += seg[i++]!;
    const t = seg[i]! > 0 ? (target - acc) / seg[i]! : 0;
    const a = ring[i]!;
    const b = ring[i + 1]!;
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])]);
  }
  return out;
}

/** 로프트 단면 분할 수: 단면 최대 반지름에서 현 오차가 tol 이하 (8의 배수, 32~256) */
export function loftSegments(profiles: Profile[], tol: number): number {
  const r = Math.max(...profiles.map((p) => {
    const b = profileBounds(p);
    return Math.hypot(b.width, b.height) / 2;
  }));
  const n = r <= tol ? 32 : Math.ceil(Math.PI / Math.acos(1 - tol / r));
  return Math.min(256, Math.max(32, Math.ceil(n / 8) * 8));
}

/** 프로파일 단면의 resample 시작 기준 = 바운딩 박스 중심 */
export function sectionPoints(p: Profile, n: number): Point2[] {
  return resample(outline(p), n, profileBounds(p).center);
}

/** 헬릭스 한 바퀴당 단면 수 (회전과 같은 현 오차 규칙, 8의 배수) */
export function helixStepsPerTurn(rMax: number, tol: number): number {
  const n = rMax <= tol ? 16 : Math.ceil(Math.PI / Math.acos(1 - tol / rMax));
  return Math.min(256, Math.max(16, Math.ceil(n / 8) * 8));
}

/** 헬릭스 단면 점: 다각형·사각형은 꼭짓점 그대로(모서리 보존), 원·슬롯은 현 오차 tol 로 나눈 점 */
export function helixProfilePoints(p: Profile, tol: number): Point2[] {
  if (p.type === 'polygon' || p.type === 'rectangle') return outline(p);
  return sectionPoints(p, loftSegments([p], tol));
}

/**
 * 헬릭스 단면들 (스케치 평면 좌표 u, v, w). 단계 k: θ = 2π·turns·k/S,
 * (u, v) → (u·cosθ, v + pitch·turns·k/S, −u·sinθ)  — 회전과 같은 방향(+u 가 −w 쪽으로)
 */
export function helixRings(pts: Point2[], pitch: number, turns: number, tol: number): [number, number, number][][] {
  const rMax = Math.max(...pts.map((q) => q[0]));
  const S = helixSteps(turns, helixStepsPerTurn(rMax, tol));
  return Array.from({ length: S + 1 }, (_, k) => {
    const th = (2 * Math.PI * turns * k) / S;
    const dv = (pitch * turns * k) / S;
    return pts.map(([u, v]) => [u * Math.cos(th), v + dv, -u * Math.sin(th)] as [number, number, number]);
  });
}

/** 헬릭스 전체 단면 수: 바퀴당 정밀도대로, 단 전체 MAX_HELIX_STEPS 이하 (긴 나사산의 계산 시간), 바퀴당 16 이상 */
export const MAX_HELIX_STEPS = 400;
export function helixSteps(turns: number, perTurn: number): number {
  return Math.max(2, Math.ceil(turns * 16), Math.min(Math.ceil(turns * perTurn), MAX_HELIX_STEPS));
}

/** 헬릭스 검사: 축 한쪽(u > 0) + 피치가 프로파일 높이(v 폭)보다 커야 바퀴끼리 겹치지 않는다 */
export function helixError(pts: Point2[], pitch: number): string | null {
  if (Math.min(...pts.map((q) => q[0])) <= 1e-9) return '헬릭스 프로파일은 회전축(u = 0)에 닿지 않게 한쪽(u > 0)에 있어야 합니다';
  const h = Math.max(...pts.map((q) => q[1])) - Math.min(...pts.map((q) => q[1]));
  if (pitch <= h + 1e-9) return `피치(${Math.round(pitch * 1000) / 1000}mm)가 프로파일 높이(${Math.round(h * 1000) / 1000}mm)보다 커야 바퀴끼리 겹치지 않습니다`;
  return null;
}
