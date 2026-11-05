import { useEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport, Grid, Line, OrbitControls } from '@react-three/drei';
import { MOUSE } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { byId, topLevelObjects } from '../../cad/modelGraph';
import { CadNode } from '../Viewport/CadObjectMesh';
import { CameraFitter } from '../Viewport/CameraFitter';
import { ProjectionSwitch } from '../Viewport/ProjectionSwitch';
import { DevProbe } from '../Viewport/DevProbe';
import { useModelingStore } from '../../features/modeling/modelingStore';
import { useEditorStore } from '../../features/selection/editorStore';
import { ChatPanel } from '../ChatPanel/ChatPanel';
import { useModelingKeys } from '../../features/modeling/useModelingKeys';
import { PolyMeshView } from './PolyMeshView';
import { ModalController } from './ModalController';
import { ModelingPicker } from './ModelingPicker';
import { AddMenu, ModelingEmptyGuide, ModelingHint, ModelingProperties, Outliner } from './ModelingPanels';

const NONE = -1 as unknown as MOUSE;

/**
 * 3D 모델링 모드 화면 (블렌더 배치): 가운데 3D 뷰포트, 오른쪽 아웃라이너(위)·속성(아래).
 * 메시 객체는 엔진 계산 없이 모델 데이터를 바로 그린다 (편집할 때마다 즉시 반응).
 */
export function ModelingWorkspace() {
  useModelingKeys();
  // 편집 대상이 사라지거나 바뀌면 오브젝트 모드로
  useEffect(
    () =>
      useSceneStore.subscribe((s) => {
        const st = useModelingStore.getState();
        if (st.mode !== 'edit') return;
        const o = s.history.present.model.objects.find((x) => x.id === s.selectedId);
        if (!o || o.kind !== 'polymesh') st.setMode('object');
        else if (st.selVerts.some((v) => v >= o.polymesh.verts.length)) st.setSel(st.selVerts.filter((v) => v < o.polymesh.verts.length));
      }),
    [],
  );
  useEffect(() => () => useModelingStore.getState().reset(), []);
  const chatOpen = useEditorStore((s) => s.chatOpen);
  return (
    <main className={`workspace modeling-workspace${chatOpen ? ' with-chat' : ''}`}>
      <ModelingViewport />
      <aside className="modeling-side">
        <Outliner />
        <ModelingProperties />
      </aside>
      {chatOpen && <ChatPanel />}
    </main>
  );
}

function ModelingViewport() {
  const ref = useRef<HTMLElement>(null);
  // 마우스 위치 (키로 시작하는 모달·Shift+A 메뉴의 기준점)
  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const r = ref.current?.getBoundingClientRect();
      if (r) useModelingStore.getState().setMouse([e.clientX - r.left, e.clientY - r.top]);
    };
    window.addEventListener('pointermove', onMove);
    return () => window.removeEventListener('pointermove', onMove);
  }, []);

  return (
    <section ref={ref} className="panel viewport modeling-viewport" aria-label="3D 뷰포트">
      <Canvas camera={{ position: [60, -80, 55], fov: 45, near: 0.1, far: 50_000 }}>
        <hemisphereLight args={['#ffffff', '#40444c', 1.15]} />
        <directionalLight position={[120, -160, 220]} intensity={1.5} />
        <directionalLight position={[-150, 100, 80]} intensity={0.45} />
        <Grid
          rotation={[Math.PI / 2, 0, 0]}
          cellSize={1}
          sectionSize={10}
          cellColor="#4a4a4a"
          sectionColor="#5c5c5c"
          cellThickness={0.6}
          sectionThickness={1}
          fadeDistance={600}
          fadeStrength={1.5}
          infiniteGrid
        />
        {/* 블렌더처럼 바닥의 X(빨강)·Y(초록) 축선 */}
        <Line points={[[-2000, 0, 0.01], [2000, 0, 0.01]]} color="#d0484e" lineWidth={1.5} />
        <Line points={[[0, -2000, 0.01], [0, 2000, 0.01]]} color="#7bb33c" lineWidth={1.5} />
        <SceneObjects />
        <ModalController />
        <ModelingPicker />
        <CameraFitter />
        <ProjectionSwitch />
        {import.meta.env.DEV && <DevProbe />}
        <OrbitControls makeDefault target={[0, 0, 10]} minDistance={2} maxDistance={5000} />
        <BlenderMouse />
        <GizmoHelper alignment="top-right" margin={[64, 64]}>
          <GizmoViewport axisColors={['#d0484e', '#7bb33c', '#4f8ad6']} labelColor="#fff" />
        </GizmoHelper>
      </Canvas>
      <ModelingEmptyGuide />
      <AddMenu />
      <ModelingHint />
    </section>
  );
}

/** 장면 객체: 메시 = 모델 데이터 그대로, 설계 부품 = 엔진 계산 결과 (모달 중이면 미리보기) */
function SceneObjects() {
  const model = useSceneStore(selectModel);
  const selectedId = useSceneStore((s) => s.selectedId);
  const index = useMemo(() => byId(model), [model]);
  const roots = useMemo(() => topLevelObjects(model), [model]);
  const mode = useModelingStore((s) => s.mode);
  const selVerts = useModelingStore((s) => s.selVerts);
  const selectMode = useModelingStore((s) => s.selectMode);
  const preview = useModelingStore((s) => s.preview);
  return (
    <>
      {roots.map((o) => {
        const p = preview?.objectId === o.id ? preview : null;
        if (o.kind === 'polymesh') {
          const editing = mode === 'edit' && o.id === selectedId;
          return (
            <PolyMeshView
              key={o.id}
              object={o}
              mesh={p?.mesh}
              transform={p?.transform}
              selected={o.id === selectedId}
              editing={editing}
              selVerts={editing ? (p?.afterSel && p.mesh ? p.afterSel : selVerts) : []}
              selectMode={selectMode}
            />
          );
        }
        const shown = p?.transform ? { ...o, transform: p.transform } : o;
        return <CadNode key={o.id} object={shown} index={index} mode="solid" />;
      })}
    </>
  );
}

/**
 * 블렌더 마우스: 가운데 드래그 = 회전, Shift+가운데 = 이동, Ctrl+가운데 = 확대/축소, 휠 = 확대/축소,
 * 왼쪽 = 선택 (Alt+왼쪽 = 회전 — 가운데 버튼 없는 마우스·트랙패드), 오른쪽 = 모달 취소
 */
function BlenderMouse() {
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const gl = useThree((s) => s.gl);
  useEffect(() => {
    if (!controls) return;
    controls.mouseButtons = { LEFT: NONE, MIDDLE: MOUSE.ROTATE, RIGHT: NONE };
    const onDown = (e: PointerEvent) => {
      if (e.button === 1) controls.mouseButtons.MIDDLE = e.shiftKey ? MOUSE.PAN : e.ctrlKey ? MOUSE.DOLLY : MOUSE.ROTATE;
      if (e.button === 0) controls.mouseButtons.LEFT = e.altKey ? (e.shiftKey ? MOUSE.PAN : MOUSE.ROTATE) : NONE;
    };
    gl.domElement.addEventListener('pointerdown', onDown, { capture: true });
    return () => gl.domElement.removeEventListener('pointerdown', onDown, { capture: true });
  }, [controls, gl]);
  return null;
}
