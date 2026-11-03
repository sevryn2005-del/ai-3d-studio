/**
 * 부모-자식 변환 합성 (불리언 객체의 자식은 부모 좌표계 기준 변환을 가진다).
 *
 * 규칙: world = parent ∘ child  (행렬로 M_world = M_parent · M_child)
 * 각 변환의 행렬 = T(position) · R(Euler XYZ, degree) — Three.js 와 백엔드(primitives.apply_transform)가 동일.
 */
import { Euler, MathUtils, Matrix4, Quaternion, Vector3 } from 'three';
import type { Transform, Vec3 } from './commandTypes';
import { normalizeAngle, roundTo } from './transformUtils';

/** 합성 결과의 부동소수점 잡음 제거 단위 (mm, °) */
const PRECISION = 1e-6;

export const IDENTITY: Transform = { position: [0, 0, 0], rotation: [0, 0, 0] };

export function toMatrix(t: Transform): Matrix4 {
  const q = new Quaternion().setFromEuler(
    new Euler(...(t.rotation.map((d) => d * MathUtils.DEG2RAD) as Vec3), 'XYZ'),
  );
  return new Matrix4().compose(new Vector3(...t.position), q, new Vector3(1, 1, 1));
}

export function fromMatrix(m: Matrix4): Transform {
  const p = new Vector3();
  const q = new Quaternion();
  m.decompose(p, q, new Vector3());
  const e = new Euler().setFromQuaternion(q, 'XYZ');
  const clean = (v: number) => roundTo(v, PRECISION);
  return {
    position: [clean(p.x), clean(p.y), clean(p.z)],
    rotation: [e.x, e.y, e.z].map((r) => clean(normalizeAngle(r * MathUtils.RAD2DEG))) as Vec3,
  };
}

/** 부모 좌표계의 변환 → 월드(또는 상위) 좌표계 */
export function composeTransform(parent: Transform, child: Transform): Transform {
  return fromMatrix(toMatrix(parent).multiply(toMatrix(child)));
}

/** 월드 변환 → 부모 좌표계 기준 변환 (parent⁻¹ ∘ world) */
export function relativeTransform(parent: Transform, world: Transform): Transform {
  return fromMatrix(toMatrix(parent).invert().multiply(toMatrix(world)));
}
