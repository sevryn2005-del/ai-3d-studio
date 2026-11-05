/**
 * 도면 보기 방향 (서버 app/cad/drawing.py VIEWS 와 같은 표).
 * toward = 보는 사람 쪽 (투상 방향의 반대), right = 보기의 오른쪽. 위쪽 = toward × right.
 * 3각법: 정면 아래-왼쪽, 평면은 정면 위, 우측면은 정면 오른쪽.
 */
import type { DrawingViewName } from '../engine/types';

type V3 = [number, number, number];
const S2 = Math.SQRT1_2;
const S3 = 1 / Math.sqrt(3);

export const DRAWING_VIEWS: Record<DrawingViewName, { label: string; toward: V3; right: V3 }> = {
  front: { label: '정면도', toward: [0, -1, 0], right: [1, 0, 0] },
  top: { label: '평면도', toward: [0, 0, 1], right: [1, 0, 0] },
  right: { label: '우측면도', toward: [1, 0, 0], right: [0, 1, 0] },
  iso: { label: '등각도', toward: [S3, -S3, S3], right: [S2, S2, 0] },
};
export const ALL_VIEWS: readonly DrawingViewName[] = ['front', 'top', 'right', 'iso'];

export const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

/** 월드 점 → 보기 평면 좌표 (정사영) */
export function projectPoint(view: DrawingViewName, p: V3): [number, number] {
  const { toward, right } = DRAWING_VIEWS[view];
  const up = cross(toward, right);
  return [p[0] * right[0] + p[1] * right[1] + p[2] * right[2], p[0] * up[0] + p[1] * up[1] + p[2] * up[2]];
}
