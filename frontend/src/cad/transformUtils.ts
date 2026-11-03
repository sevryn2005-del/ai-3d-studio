/**
 * 화면 조작(Three.js 객체 상태) → CAD 명령 값 변환.
 * 뷰포트 기즈모는 Three.js 객체를 직접 움직이지만, 설계 원본에는
 * 이 함수를 거쳐 반올림·정규화된 값만 set_transform 명령으로 기록된다.
 */
import type { Transform, Vec3 } from './commandTypes';
import { DEG2RAD } from './units';

/** 스냅이 꺼져 있을 때도 적용되는 최소 정밀도 (mm, °). 부동소수점 잡음 제거용. */
export const BASE_PRECISION = 0.01;

export interface SnapSettings {
  translation: number | null; // mm
  rotation: number | null; // degree
}

export const DEFAULT_SNAP: SnapSettings = { translation: 1, rotation: 15 };

export function roundTo(value: number, step: number): number {
  const r = Math.round(value / step) * step;
  // 0.1 + 0.2 같은 이진 부동소수점 오차 제거, -0 제거
  return Number(r.toFixed(6)) + 0;
}

/** 각도를 (-180, 180] 범위로 정규화 */
export function normalizeAngle(deg: number): number {
  let a = deg % 360;
  if (a > 180) a -= 360;
  if (a <= -180) a += 360;
  return a + 0;
}

interface XYZ {
  x: number;
  y: number;
  z: number;
}

/** position(mm), rotation(rad, XYZ Euler) → Transform(mm, degree) */
export function transformFromObject3D(position: XYZ, rotationRad: XYZ, snap: SnapSettings): Transform {
  const tStep = snap.translation ?? BASE_PRECISION;
  const rStep = snap.rotation ?? BASE_PRECISION;
  const pos: Vec3 = [roundTo(position.x, tStep), roundTo(position.y, tStep), roundTo(position.z, tStep)];
  const rot: Vec3 = [rotationRad.x, rotationRad.y, rotationRad.z].map((r) =>
    roundTo(normalizeAngle(r / DEG2RAD), rStep),
  ) as Vec3;
  return { position: pos, rotation: rot };
}

export function transformsEqual(a: Transform, b: Transform, eps = 1e-6): boolean {
  const eq = (u: Vec3, v: Vec3) => u.every((x, i) => Math.abs(x - v[i]!) < eps);
  return eq(a.position, b.position) && eq(a.rotation, b.rotation);
}

/**
 * 반지름 radius 인 구가 화면에 꽉 차도록 하는 카메라 거리.
 * 세로/가로 시야각 중 좁은 쪽 기준, margin 배 만큼 여유를 둔다.
 */
export function fitDistance(radius: number, fovDeg: number, aspect: number, margin = 1.25): number {
  const vFov = fovDeg * DEG2RAD;
  const hFov = 2 * Math.atan(Math.tan(vFov / 2) * aspect);
  const fov = Math.min(vFov, hFov);
  return (Math.max(radius, 1) * margin) / Math.sin(fov / 2);
}
