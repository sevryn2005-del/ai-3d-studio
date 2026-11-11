import { LocalEnvironment } from './LocalEnvironment';
import { useMemo, useRef } from 'react';
import { Canvas } from '@react-three/fiber';
import { GizmoHelper, GizmoViewport, Grid, OrbitControls } from '@react-three/drei';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { CadNode } from './CadObjectMesh';
import { byId, topLevelObjects } from '../../cad/modelGraph';
import { SelectionGizmo } from './SelectionGizmo';
import { CameraFitter } from './CameraFitter';
import { ProjectionSwitch } from './ProjectionSwitch';
import { ViewportToolbar } from './ViewportToolbar';
import { DevProbe } from './DevProbe';
import { SketchOutlines } from './SketchOutlines';
import { SketchPaper } from './SketchPaper';
import { SketchPointDrag } from './SketchPointDrag';
import { SketchTrimTool } from './SketchTrimTool';
import { SketchDimensionTool } from './SketchDimensionTool';
import { SketchOptionsBar } from './SketchOptionsBar';
import { useActiveSketch } from '../../features/sketch/activeSketch';
import { useSketchView } from '../../features/sketch/sketchSettings';
import { SketchDrawTool } from './SketchDrawTool';
import { MouseScheme } from './MouseScheme';
import { ConfirmationCorner, PendingPreview, PlanePicker } from './FeatureFlow';
import { useEditorStore } from '../../features/selection/editorStore';
import { AssemblyPanels } from './AssemblyPanels';
import { DrawingPanel } from '../Drawing/DrawingPanel';
import { PickBar, PickOverlay } from './PickOverlay';
import { pickBusy } from '../../features/selection/pick';
import { MeasureEntityPanel } from './PickFlows';
import { ReferenceGeometry, ReferencePanel } from './ReferenceGeometry';
import { ExplodedPart } from './ExplodedPart';
import { RenderPanel, RenderTaker } from './RenderPanel';
import { Timeline } from './Timeline';
import { LoftPanel, SweepPanel, MassPanel, MeasureOverlay, MeasureReadout, ScreenshotTaker, SectionClip, SectionPanel, DraftPanel, ThicknessPanel } from './ViewTools';
import { startSketch } from '../../features/selection/featureFlow';

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
  const drawTool = useEditorStore((s) => s.drawTool);
  const mouseScheme = useEditorStore((s) => s.mouseScheme);
  // 스케치 중 종이를 깔면 바닥 격자는 숨긴다 (종이의 모눈이 대신)
  const sketchActive = useActiveSketch();
  const paperOn = useSketchView((s) => s.paper);
  const onPaper = !!sketchActive && paperOn;

  return (
    <section className="panel viewport" aria-label="3D 뷰포트">
      <Canvas
        camera={{ position: [60, -80, 55], fov: 45, near: 0.1, far: 50_000 }}
        onPointerMissed={(e) => {
          if (gizmoActiveRef.current || useEditorStore.getState().drawTool || pickBusy()) return;
          if (e.button === 0) select(null);
        }}
      >
        {/* 배경은 CSS 그라디언트 (.viewport) — 밝은 작업 화면 */}
        <hemisphereLight args={['#ffffff', '#3a4250', 1.1]} />
        <LocalEnvironment />
        <directionalLight position={[120, -160, 220]} intensity={1.6} />
        <directionalLight position={[-150, 100, 80]} intensity={0.4} />

        {/* 출력 베드: 1mm 셀, 10mm 섹션. drei Grid는 XZ 평면이므로 XY로 회전 */}
        {!onPaper && <Grid
          rotation={[Math.PI / 2, 0, 0]}
          cellSize={1}
          sectionSize={10}
          cellColor="#2c323b"
          sectionColor="#46505e"
          cellThickness={0.6}
          sectionThickness={1}
          fadeDistance={600}
          fadeStrength={1.5}
          infiniteGrid
        />}

        {roots.map((o) => (
          <ExplodedPart key={o.id} id={o.id}>
            <CadNode object={o} index={index} mode="solid" />
          </ExplodedPart>
        ))}

        <SketchPaper />
        <SketchOutlines />
        <SketchDrawTool />
        <SketchPointDrag />
        <SketchTrimTool />
        <SketchDimensionTool />
        <PlanePicker />
        <PendingPreview />
        <SectionClip />
        <MeasureOverlay />
        <ReferenceGeometry />
        <RenderTaker />
        <PickOverlay />
        <ScreenshotTaker />
        {!drawTool && <SelectionGizmo activeRef={gizmoActiveRef} />}
        <CameraFitter />
        <ProjectionSwitch />
        {import.meta.env.DEV && <DevProbe />}

        {/* 마우스 버튼 배정은 MouseScheme (솔리드웍스식 / 간편). 그리기 중 왼쪽 버튼은 그리기 */}
        <OrbitControls makeDefault target={[0, 0, 10]} minDistance={2} maxDistance={5000} />
        <MouseScheme drawLocked={!!drawTool} />
        <GizmoHelper alignment="bottom-right" margin={[64, 64]}>
          <GizmoViewport axisColors={['#e5534b', '#57ab5a', '#539bf5']} labelColor="#fff" />
        </GizmoHelper>
      </Canvas>
      <ViewportToolbar />
      <SketchOptionsBar />
      <ConfirmationCorner />
      <SectionPanel />
      <DraftPanel />
      <ReferencePanel />
      <RenderPanel />
      <Timeline />
      <ThicknessPanel />
      <MeasureReadout />
      <MassPanel />
      <LoftPanel />
      <SweepPanel />
      <AssemblyPanels />
      <PickBar />
      <MeasureEntityPanel />
      <DrawingPanel />
      <DesignStartGuide />
      <div className="viewport-hint" data-testid="viewport-hint">
        {drawTool
          ? drawTool === 'dimension' ? '클릭: 변(길이)·원(지름) — 점 두 개(거리)·변 두 개(각도)는 차례로 · 변 다음 빈 곳 클릭 = 길이 · 값 입력 후 Enter · Esc: 취소·끝내기' : drawTool === 'trim' ? '클릭: 구성선·경로의 지울 조각 (교차점 사이) · Esc: 끝내기' : drawTool === 'extend' ? '클릭: 늘일 선 끝 (가장 가까운 요소까지) · Esc: 끝내기' : `${drawTool === 'spline' ? '클릭: 스플라인이 지날 점 (첫 점 클릭 = 닫힌 곡선, 마지막 점 다시 클릭·Enter = 열린 곡선)' : drawTool === 'arc' ? '클릭: 호 시작점 → 끝점 → 호가 지날 점' : drawTool === 'polygon' ? '클릭: 다각형 꼭짓점 (첫 점 클릭·Enter 로 닫기)' : drawTool === 'path' ? '클릭: 경로 점 (마지막 점 다시 클릭·Enter 로 끝)' : `드래그: ${drawTool === 'rectangle' ? '사각형 (모서리 → 모서리)' : drawTool === 'ellipse' ? '타원 (바운딩 박스 모서리 → 모서리)' : '원 (중심 → 반지름)'} 그리기`} · ${navHint(mouseScheme, true)} · Esc: 그리기 끝내기`
          : navHint(mouseScheme, false)}
      </div>
    </section>
  );
}

/** 화면 아래 조작 안내 (마우스 방식에 맞게) */
function navHint(scheme: 'solidworks' | 'simple', drawing: boolean): string {
  if (scheme === 'solidworks') return '가운데 버튼 드래그: 회전 · Ctrl+가운데: 이동 · 휠: 확대/축소 · Ctrl+1~7: 표준 보기 · 스페이스: 보기 방향';
  return drawing ? '오른쪽 드래그: 이동 · 휠: 확대/축소' : '왼쪽 드래그: 회전 · 오른쪽 드래그: 이동 · 휠: 확대/축소 · Ctrl+1~7: 표준 보기';
}

/** 설계 모드의 빈 부품: 솔리드웍스처럼 평면 → 스케치 → 피처 순서를 안내 */
function DesignStartGuide() {
  const model = useSceneStore(selectModel);
  const drawTool = useEditorStore((s) => s.drawTool);
  const picking = useEditorStore((s) => s.pickingPlane);
  if (model.workspace !== 'design' || model.objects.length || model.sketches.length || drawTool || picking) return null;
  return (
    <div className="start-guide" data-testid="design-start-guide">
      <strong>새 부품</strong>
      <ol>
        <li>스케치할 평면을 고릅니다 (정면 · 윗면 · 우측면)</li>
        <li>사각형·원·선으로 2D 모양을 그리고 치수를 넣습니다</li>
        <li>오른쪽 위 ✓ 로 스케치를 마칩니다</li>
        <li>피처 탭 → 돌출·회전으로 3D 부품을 만듭니다</li>
      </ol>
      <button className="ok" onClick={startSketch} data-testid="guide-start-sketch">
        스케치 시작
      </button>
    </div>
  );
}
