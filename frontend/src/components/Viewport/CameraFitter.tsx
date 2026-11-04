import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Box3, OrthographicCamera, PerspectiveCamera, Sphere, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { fitDistance } from '../../cad/transformUtils';
import { useEditorStore, type ViewName } from '../../features/selection/editorStore';
import { selectSelectedSketch, useSceneStore, selectModel } from '../../cad/sceneStore';
import { sketchWorldMatrix } from '../../cad/sketchPlane';

/**
 * 표준 보기: 카메라가 "어느 쪽에서" 보는지 (Z-up). 정면 = −Y 쪽에서 +Y 를 봄 (정면 평면 = XZ).
 * 위·아래는 위쪽 벡터(Z)와 평행하지 않게 아주 조금 기울인다 (궤도 조작이 뒤집히지 않도록).
 */
const VIEW_DIRS: Record<Exclude<ViewName, 'normal'>, [number, number, number]> = {
  front: [0, -1, 0],
  back: [0, 1, 0],
  left: [-1, 0, 0],
  right: [1, 0, 0],
  top: [0, -1e-4, 1],
  bottom: [0, -1e-4, -1],
  iso: [1, -1, 1],
};

/**
 * fitRequest 가 바뀌면 현재 보는 방향을 유지한 채 모든 CAD 객체가 보이도록 카메라를 옮긴다.
 * 객체가 없으면 원점 주변 기본 영역을 보여준다.
 */
export function CameraFitter() {
  const fitRequest = useEditorStore((s) => s.fitRequest);
  const viewRequest = useEditorStore((s) => s.viewRequest);
  const camera = useThree((s) => s.camera);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const scene = useThree((s) => s.scene);
  const size = useThree((s) => s.size);

  useEffect(() => {
    if ((fitRequest === 0 && !viewRequest) || !controls) return;
    const ortho = camera instanceof OrthographicCamera;
    if (!ortho && !(camera instanceof PerspectiveCamera)) return;

    const box = new Box3();
    scene.traverse((o) => {
      // 화면 맞춤 대상: CAD 객체 + 보조 표시(평면 고르기 중인 기준 평면, 확정 전 피처 미리보기)
      if (o.userData.cadObject || o.userData.fitHelper) box.expandByObject(o);
    });
    const sphere = box.isEmpty() ? new Sphere(new Vector3(0, 0, 10), 20) : box.getBoundingSphere(new Sphere());

    const dir = viewDirection(viewRequest?.n === lastView.n ? null : viewRequest?.name ?? null) ??
      new Vector3().subVectors(camera.position, controls.target).normalize();
    lastView.n = viewRequest?.n ?? 0;
    if (dir.lengthSq() === 0) dir.set(0.5, -0.7, 0.5).normalize();
    const dist = fitDistance(sphere.radius, ortho ? 45 : (camera as PerspectiveCamera).fov, size.width / size.height);
    if (ortho) camera.zoom = Math.min(size.width, size.height) / (2 * Math.max(sphere.radius, 1) * 1.25);

    controls.target.copy(sphere.center);
    camera.position.copy(sphere.center).addScaledVector(dir, dist);
    camera.updateProjectionMatrix();
    controls.update();
    // fitRequest·viewRequest 이외의 값 변화에는 반응하지 않는다 (사용자가 요청할 때만 이동)
  }, [fitRequest, viewRequest]);

  return null;
}

/** 마지막으로 처리한 보기 요청 (같은 요청을 화면 맞춤 때 다시 적용하지 않도록) */
const lastView = { n: 0 };

/** 보기 이름 → 카메라 방향 (대상에서 카메라 쪽). normal = 선택한 스케치 평면을 정면으로 */
function viewDirection(name: ViewName | null): Vector3 | null {
  if (!name) return null;
  if (name !== 'normal') return new Vector3(...VIEW_DIRS[name]).normalize();
  const state = useSceneStore.getState();
  const sketch = selectSelectedSketch(state);
  const frame = sketch ? sketchWorldMatrix(selectModel(state), sketch) : null;
  if (!frame) return null;
  const n = new Vector3(0, 0, 1).transformDirection(frame);
  // 법선이 위쪽(Z)과 평행하면 아주 조금 기울인다
  if (Math.abs(n.z) > 0.9999) n.add(new Vector3(0, -1e-4, 0)).normalize();
  return n;
}
