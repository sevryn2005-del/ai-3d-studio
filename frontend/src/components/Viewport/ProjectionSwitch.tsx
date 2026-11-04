/**
 * 원근 ↔ 직교 투영 전환 (솔리드웍스 "원근 보기", 블렌더 숫자패드 5).
 * 같은 위치·방향을 유지하고, 직교의 배율은 회전 중심까지 거리에서 원근과 같은 크기로 보이게 맞춘다.
 */
import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { OrthographicCamera, PerspectiveCamera, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useEditorStore } from '../../features/selection/editorStore';

export const PERSPECTIVE_FOV = 45;

export function ProjectionSwitch() {
  const projection = useEditorStore((s) => s.projection);
  const { camera, size, set, controls } = useThree();
  useEffect(() => {
    const ortho = camera instanceof OrthographicCamera;
    if ((projection === 'orthographic') === ortho) return;
    const target = (controls as OrbitControlsImpl | null)?.target ?? new Vector3();
    const dist = camera.position.distanceTo(target);
    const visibleH = 2 * dist * Math.tan(((PERSPECTIVE_FOV / 2) * Math.PI) / 180);
    let next: PerspectiveCamera | OrthographicCamera;
    if (projection === 'orthographic') {
      const c = new OrthographicCamera(-size.width / 2, size.width / 2, size.height / 2, -size.height / 2, -50_000, 50_000);
      c.zoom = size.height / Math.max(visibleH, 1e-6);
      next = c;
    } else {
      const c = new PerspectiveCamera(PERSPECTIVE_FOV, size.width / size.height, 0.1, 50_000);
      // 직교 배율에 맞는 거리로 카메라를 옮겨 같은 크기로 보이게
      const o = camera as OrthographicCamera;
      const h = size.height / o.zoom;
      const d = h / (2 * Math.tan(((PERSPECTIVE_FOV / 2) * Math.PI) / 180));
      const dir = camera.position.clone().sub(target).normalize();
      c.position.copy(target).addScaledVector(dir, d);
      next = c;
    }
    if (projection === 'orthographic') next.position.copy(camera.position);
    next.quaternion.copy(camera.quaternion);
    next.updateProjectionMatrix();
    set({ camera: next });
  }, [projection, camera, size, set, controls]);
  return null;
}
