import { useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from '@react-three/drei';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { CadNode } from './CadObjectMesh';
import { byId, topLevelObjects } from '../../cad/modelGraph';
import { SelectionGizmo } from './SelectionGizmo';
import { CameraFitter } from './CameraFitter';
import { ViewportToolbar } from './ViewportToolbar';
import { DevProbe } from './DevProbe';
import { SketchOutlines } from './SketchOutlines';

/**
 * 3D 뷰포트. 1 Three.js 단위 = 1 mm, Z-up.
 * - 좌클릭 드래그: 회전 / 우클릭 드래그: 이동 / 휠: 확대·축소
 * - 객체 클릭: 선택, 빈 공간 클릭: 선택 해제
 * - 기즈모 드래그: 선택 객체 이동/회전
 */
export function Viewport() {
  const model = useSceneStore(selectModel);
  const index = useMemo(() => byId(model), [model]);
  const roots = useMemo(() => topLevelObjects(model), [model]);
  const select = useSceneStore((s) => s.select);
  // 기즈모 핸들을 누르고 있는 동안 true. 핸들 클릭이 "빈 공간 클릭"으로 처리되어 선택이 풀리는 것을 막는다.
  const gizmoActiveRef = useRef(false);

  return (
    <section className="panel viewport" aria-label="3D 뷰포트">
      <Canvas
        camera={{ position: [60, -80, 55], fov: 45, near: 0.1, far: 50_000 }}
        onPointerMissed={(e) => {
          if (gizmoActiveRef.current) return;
          if (e.button === 0) select(null);
        }}
      >
        <color attach="background" args={['#1c1f24']} />
        <hemisphereLight args={['#ffffff', '#3a3f47', 0.9]} />
        <directionalLight position={[120, -160, 220]} intensity={1.6} />
        <directionalLight position={[-150, 100, 80]} intensity={0.4} />

        {/* 출력 베드: 1mm 셀, 10mm 섹션. drei Grid는 XZ 평면이므로 XY로 회전 */}
        <Grid
          rotation={[Math.PI / 2, 0, 0]}
          cellSize={1}
          sectionSize={10}
          cellColor="#2c3139"
          sectionColor="#3e4651"
          cellThickness={0.6}
          sectionThickness={1}
          fadeDistance={600}
          fadeStrength={1.5}
          infiniteGrid
        />

        {roots.map((o) => (
          <CadNode key={o.id} object={o} index={index} mode="solid" />
        ))}

        <SketchOutlines />
        <SelectionGizmo activeRef={gizmoActiveRef} />
        <CameraFitter />
        {import.meta.env.DEV && <DevProbe />}

        <OrbitControls makeDefault target={[0, 0, 10]} minDistance={2} maxDistance={5000} />
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport axisColors={['#e5534b', '#57ab5a', '#539bf5']} labelColor="#fff" />
        </GizmoHelper>
      </Canvas>
      <ViewportToolbar />
      <div className="viewport-hint">드래그: 회전 · 우클릭 드래그: 이동 · 휠: 확대/축소</div>
    </section>
  );
}
