import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Box3, PerspectiveCamera, Sphere, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { fitDistance } from '../../cad/transformUtils';
import { useEditorStore } from '../../features/selection/editorStore';

/**
 * fitRequest 가 바뀌면 현재 보는 방향을 유지한 채 모든 CAD 객체가 보이도록 카메라를 옮긴다.
 * 객체가 없으면 원점 주변 기본 영역을 보여준다.
 */
export function CameraFitter() {
  const fitRequest = useEditorStore((s) => s.fitRequest);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);

  useEffect(() => {
    if (fitRequest === 0 || !controls || !(camera instanceof PerspectiveCamera)) return;

    const box = new Box3();
    scene.traverse((o) => {
      if (o.userData.cadObject) box.expandByObject(o);
    });
    const sphere = box.isEmpty() ? new Sphere(new Vector3(0, 0, 10), 20) : box.getBoundingSphere(new Sphere());

    const dir = new Vector3().subVectors(camera.position, controls.target).normalize();
    if (dir.lengthSq() === 0) dir.set(0.5, -0.7, 0.5).normalize();
    const dist = fitDistance(sphere.radius, camera.fov, size.width / size.height);

    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.updateProjectionMatrix();
    controls.update();
    // fitRequest 이외의 값 변화에는 반응하지 않는다 (사용자가 요청할 때만 이동)
  }, [fitRequest]);

  return null;
}
