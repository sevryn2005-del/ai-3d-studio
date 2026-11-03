/**
 * 스케치 평면 좌표계 → 객체(돌출) 로컬 좌표계. CadQuery 의 이름 평면과 같은 규약 (서버와 같은 형상).
 * 스케치 좌표 (u, v) 는 평면 위, w 는 평면 법선(돌출 방향). 원점 = 법선 × offset.
 *   XY: u=X, v=Y, 법선 +Z
 *   XZ: u=X, v=Z, 법선 −Y
 *   YZ: u=Y, v=Z, 법선 +X
 */
import { Matrix4, Vector3 } from 'three';
import type { SketchPlane } from './commandTypes';
import type { Profile } from './sketch';

const BASES: Record<SketchPlane['type'], [Vector3, Vector3, Vector3]> = {
  XY: [new Vector3(1, 0, 0), new Vector3(0, 1, 0), new Vector3(0, 0, 1)],
  XZ: [new Vector3(1, 0, 0), new Vector3(0, 0, 1), new Vector3(0, -1, 0)],
  YZ: [new Vector3(0, 1, 0), new Vector3(0, 0, 1), new Vector3(1, 0, 0)],
};

export const PLANE_LABEL: Record<SketchPlane['type'], string> = {
  XY: 'XY (바닥, 위로 돌출)',
  XZ: 'XZ (정면, 앞으로 돌출)',
  YZ: 'YZ (측면, 오른쪽으로 돌출)',
};

export function planeMatrix(plane: SketchPlane): Matrix4 {
  const [u, v, n] = BASES[plane.type];
  const m = new Matrix4().makeBasis(u, v, n);
  const o = n.clone().multiplyScalar(plane.offset);
  return m.setPosition(o);
}

/** 평면 좌표 크기 (u 폭, v 폭, 법선 두께) → 객체 로컬 X·Y·Z 크기 */
export function planeSizeToLocal(plane: SketchPlane, [su, sv, sn]: [number, number, number]): [number, number, number] {
  switch (plane.type) {
    case 'XY':
      return [su, sv, sn];
    case 'XZ':
      return [su, sn, sv];
    case 'YZ':
      return [sn, su, sv];
  }
}

/**
 * 화면 미리보기용: 중심이 원점인 Three.js 기본 도형(상자 w×h×d, 원통은 Y축)을 돌출 형상 위치에 놓는 행렬.
 * 엔진 메시가 오기 전 미리보기와 엔진 결과가 같은 자리에 있어야 한다.
 */
export function extrudePreviewMatrix(profile: Profile, distance: number): Matrix4 {
  const local = new Matrix4().makeTranslation(profile.center[0], profile.center[1], distance / 2);
  if (profile.type === 'circle') local.multiply(new Matrix4().makeRotationX(Math.PI / 2)); // 원통 Y축 → 법선
  return planeMatrix(profile.plane).multiply(local);
}
