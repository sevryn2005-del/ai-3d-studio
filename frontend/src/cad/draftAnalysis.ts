/**
 * 구배 분석 (솔리드웍스 Draft Analysis): 빼는 방향(pull)에 대해 면마다 구배 각 = asin(법선 · pull).
 * - 양(+) 구배 ≥ 한계: 빼는 쪽으로 열린 면 (초록)
 * - 음(−) 구배 ≤ −한계: 반대쪽 금형으로 빠지는 면 (빨강)
 * - 그 사이 (|각| < 한계): 구배가 모자라 금형에서 긁히는 벽 (노랑) — 구배를 더 주어야 한다
 * 화면 분석만 (저장 형식 무관). 면 판정은 삼각형 법선 (곡면은 삼각형마다).
 */
import { BufferAttribute, Euler, Matrix4, Vector3, type BufferGeometry } from 'three';
import { create } from 'zustand';

export type DraftClass = 'positive' | 'negative' | 'insufficient';
export const DRAFT_COLORS: Record<DraftClass, [number, number, number]> = {
  positive: [0.2, 0.72, 0.33],
  negative: [0.86, 0.23, 0.2],
  insufficient: [0.97, 0.78, 0.15],
};
export const DRAFT_LABELS: Record<DraftClass, string> = {
  positive: '양 구배',
  negative: '음 구배',
  insufficient: '구배 부족',
};

/** 법선 n (단위 아니어도 됨) · 빼는 방향 pull (단위) → 구배 각 (°, −90~90) */
export function draftAngle(n: readonly number[], pull: readonly number[]): number {
  const l = Math.hypot(n[0]!, n[1]!, n[2]!);
  if (l < 1e-15) return 0;
  const d = (n[0]! * pull[0]! + n[1]! * pull[1]! + n[2]! * pull[2]!) / l;
  return (Math.asin(Math.max(-1, Math.min(1, d))) * 180) / Math.PI;
}

export function draftClass(angle: number, limit: number): DraftClass {
  if (angle >= limit) return 'positive';
  if (angle <= -limit) return 'negative';
  return 'insufficient';
}

/** 화면용: 메시(객체 로컬) → 인덱스 없는 복사본 + 삼각형별 색, 넓이 합계 (mm²) */
export function draftGeometry(g: BufferGeometry, pull: readonly number[], limit: number): { geometry: BufferGeometry; area: Record<DraftClass, number> } {
  const out = g.index ? g.toNonIndexed() : g.clone();
  out.deleteAttribute('normal');
  out.computeVertexNormals(); // 인덱스 없음 → 삼각형 법선 (평면 음영과 같음)
  const p = out.getAttribute('position');
  const colors = new Float32Array(p.count * 3);
  const area: Record<DraftClass, number> = { positive: 0, negative: 0, insufficient: 0 };
  for (let i = 0; i + 2 < p.count; i += 3) {
    const u = [p.getX(i + 1) - p.getX(i), p.getY(i + 1) - p.getY(i), p.getZ(i + 1) - p.getZ(i)];
    const v = [p.getX(i + 2) - p.getX(i), p.getY(i + 2) - p.getY(i), p.getZ(i + 2) - p.getZ(i)];
    const n = [u[1]! * v[2]! - u[2]! * v[1]!, u[2]! * v[0]! - u[0]! * v[2]!, u[0]! * v[1]! - u[1]! * v[0]!];
    const cls = draftClass(draftAngle(n, pull), limit);
    area[cls] += Math.hypot(n[0]!, n[1]!, n[2]!) / 2;
    const c = DRAFT_COLORS[cls];
    for (let k = 0; k < 3; k++) colors.set(c, (i + k) * 3);
  }
  out.setAttribute('color', new BufferAttribute(colors, 3));
  return { geometry: out, area };
}

/** 월드 빼는 방향 (축·뒤집기) → 객체 로컬 (회전 degree, XYZ) */
export function localPull(axis: 'x' | 'y' | 'z', flip: boolean, rotationDeg: readonly number[]): [number, number, number] {
  const w = new Vector3(axis === 'x' ? 1 : 0, axis === 'y' ? 1 : 0, axis === 'z' ? 1 : 0).multiplyScalar(flip ? -1 : 1);
  const r = new Matrix4().makeRotationFromEuler(new Euler(...(rotationDeg.map((d) => (d * Math.PI) / 180) as [number, number, number]), 'XYZ'));
  return w.applyMatrix4(r.transpose()).toArray() as [number, number, number];
}

/** 객체별 넓이 합계 (패널이 더해 보여 줌) */
export const useDraftStats = create<{ byObject: Record<string, Record<DraftClass, number>>; put: (id: string, a: Record<DraftClass, number> | null) => void }>((set) => ({
  byObject: {},
  put: (id, a) =>
    set((s) => {
      const next = { ...s.byObject };
      if (a) next[id] = a;
      else delete next[id];
      return { byObject: next };
    }),
}));
