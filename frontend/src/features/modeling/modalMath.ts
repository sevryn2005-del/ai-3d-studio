/**
 * 모달 조작 (G/R/S) 계산 — 순수 함수 (모델링 모드).
 * 블렌더처럼 축 잠금(X/Y/Z, 월드 축)과 입력한 값을 받는다. 모든 행렬은 월드 기준으로 만든 뒤
 * 객체 로컬로 옮겨(obj⁻¹ · M · obj) 점에 적용한다 → 객체가 돌아가 있어도 "X" 는 월드 X.
 */
import { Matrix4, Vector3 } from 'three';
import type { Transform } from '../../cad/commandTypes';
import { fromMatrix, toMatrix } from '../../cad/transformMath';
import type { V3 } from '../../cad/polymesh';
import type { Axis } from './modelingStore';

export const AXIS_VEC: Record<Axis, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** 키보드로 친 값 → 숫자 ("-" 만, "." 만은 아직 값 없음) */
export function parseTyped(t: string): number | null {
  if (!/^-?\d*\.?\d*$/.test(t) || !/\d/.test(t)) return null;
  const v = Number(t);
  return Number.isFinite(v) ? v : null;
}

/** 모달 입력에 키 하나 반영 (숫자·소수점·마이너스·지우기). 처리했으면 새 문자열, 아니면 null */
export function typeKey(typed: string, key: string): string | null {
  if (/^\d$/.test(key)) return typed + key;
  if (key === '.' && !typed.includes('.')) return typed + '.';
  if (key === '-') return typed.startsWith('-') ? typed.slice(1) : '-' + typed;
  if (key === 'Backspace') return typed.slice(0, -1);
  return null;
}

/** 이동: 축 잠금이면 그 축 성분만. 입력값이 있으면 그 축(없으면 X)으로 그 거리 */
export function grabDelta(mouseDelta: V3, axis: Axis | null, typed: number | null): V3 {
  if (typed !== null) {
    const a = AXIS_VEC[axis ?? 'x'];
    return [a[0] * typed, a[1] * typed, a[2] * typed];
  }
  if (!axis) return mouseDelta;
  const a = AXIS_VEC[axis];
  const d = mouseDelta[0] * a[0] + mouseDelta[1] * a[1] + mouseDelta[2] * a[2];
  return [a[0] * d, a[1] * d, a[2] * d];
}

/** 월드 기준 조작 행렬 (pivot 기준 회전·크기) */
export function worldMatrix(
  op: { kind: 'grab'; delta: V3 } | { kind: 'rotate'; axis: V3; degrees: number } | { kind: 'scale'; factor: number; axis: V3 | null },
  pivot: V3,
): Matrix4 {
  if (op.kind === 'grab') return new Matrix4().makeTranslation(...op.delta);
  const toPivot = new Matrix4().makeTranslation(...pivot);
  const fromPivot = new Matrix4().makeTranslation(-pivot[0], -pivot[1], -pivot[2]);
  let core: Matrix4;
  if (op.kind === 'rotate') core = new Matrix4().makeRotationAxis(new Vector3(...op.axis).normalize(), (op.degrees * Math.PI) / 180);
  else if (!op.axis) core = new Matrix4().makeScale(op.factor, op.factor, op.factor);
  else {
    // 한 축으로만 늘리기: I + (f − 1) a aᵀ
    const [x, y, z] = new Vector3(...op.axis).normalize().toArray();
    const k = op.factor - 1;
    core = new Matrix4().set(
      1 + k * x * x, k * x * y, k * x * z, 0,
      k * y * x, 1 + k * y * y, k * y * z, 0,
      k * z * x, k * z * y, 1 + k * z * z, 0,
      0, 0, 0, 1,
    );
  }
  return toPivot.multiply(core).multiply(fromPivot);
}

/** 월드 행렬을 객체 로컬 점에 쓸 행렬로: obj⁻¹ · M · obj (열 우선 16개 — mesh_edit transform) */
export function localMatrix(world: Matrix4, obj: Transform): number[] {
  const t = toMatrix(obj);
  const m = t.clone().invert().multiply(world).multiply(t);
  return m.elements.map((v) => (Math.abs(v) < 1e-12 ? 0 : Math.round(v * 1e9) / 1e9));
}

/** 객체 자체를 옮기거나 돌린 변환 (오브젝트 모드 G/R) */
export function movedTransform(world: Matrix4, obj: Transform): Transform {
  return fromMatrix(world.clone().multiply(toMatrix(obj)));
}

/** 로컬 점 → 월드 */
export function toWorld(p: V3, obj: Transform): V3 {
  return new Vector3(...p).applyMatrix4(toMatrix(obj)).toArray() as V3;
}

/** 로컬 방향 → 월드 (회전만) */
export function dirToWorld(d: V3, obj: Transform): V3 {
  return new Vector3(...d).applyMatrix4(new Matrix4().extractRotation(toMatrix(obj))).normalize().toArray() as V3;
}

/** 월드 방향 → 로컬 (회전만) */
export function dirToLocal(d: V3, obj: Transform): V3 {
  const r = new Matrix4().extractRotation(toMatrix(obj)).invert();
  return new Vector3(...d).applyMatrix4(r).toArray() as V3;
}

/** 화면 각도 변화 (도): 피벗 화면 위치 기준 시작 → 지금 마우스. 화면 좌표는 y 가 아래로 */
export function screenAngle(pivot: [number, number], from: [number, number], to: [number, number]): number {
  const a0 = Math.atan2(-(from[1] - pivot[1]), from[0] - pivot[0]);
  const a1 = Math.atan2(-(to[1] - pivot[1]), to[0] - pivot[0]);
  let d = ((a1 - a0) * 180) / Math.PI;
  while (d > 180) d -= 360;
  while (d < -180) d += 360;
  return d;
}

/** 화면 거리 비 (크기): 피벗에서 지금 마우스까지 / 시작 마우스까지 */
export function screenScale(pivot: [number, number], from: [number, number], to: [number, number]): number {
  const d0 = Math.hypot(from[0] - pivot[0], from[1] - pivot[1]);
  const d1 = Math.hypot(to[0] - pivot[0], to[1] - pivot[1]);
  return d0 < 1 ? 1 : d1 / d0;
}

const MODAL_LABEL = { grab: '이동', rotate: '회전', scale: '크기', extrude: '돌출', inset: '인셋' } as const;

/** 상태 표시줄 문구 (블렌더 헤더처럼 지금 값) */
export function modalLabel(kind: keyof typeof MODAL_LABEL, axis: Axis | null, value: string): string {
  return `${MODAL_LABEL[kind]}${axis ? ` ${axis.toUpperCase()}축` : ''} ${value}`;
}
