import type { CreateCommand } from '../../cad/commandTypes';
import { nextFreePosition } from '../../cad/placement';
import { selectCanRedo, selectCanUndo, useSceneStore } from '../../cad/sceneStore';
import { useEffect, useState } from 'react';
import { CmdIcon, type IconName } from './CmdIcon';
import { ExportMenu } from './ExportMenu';
import { useEditorStore } from '../../features/selection/editorStore';
import { startMeasurePick, startSketchOnFace } from '../Viewport/PickFlows';
import {
  importMeshFile, insertPartFile, openLoft, openSweep, quickDraft, quickEdgeFeature, quickRib, quickHelix, quickInternalThread, quickHole, quickLine, quickPattern, quickScale, quickShell, quickSlot, quickThread, startFeature, startSketch,
} from '../../features/selection/featureFlow';
import { rectangleSketchCommands } from '../../cad/sketchActions';
import { newProject, openProject, saveProject } from '../../features/projects/projectActions';
import { useIsDirty, useProjectStore } from '../../features/projects/projectStore';

/** 툴바에서 추가하는 기본 도형과 기본 치수 (mm) */
const PRIMITIVES: { label: string; sizeX: number; command: CreateCommand }[] = [
  { label: '박스', sizeX: 20, command: { type: 'create_box', width: 20, depth: 20, height: 20 } },
  { label: '원통', sizeX: 20, command: { type: 'create_cylinder', radius: 10, height: 20 } },
  { label: '구', sizeX: 20, command: { type: 'create_sphere', radius: 10 } },
  { label: '원뿔', sizeX: 20, command: { type: 'create_cone', radiusBottom: 10, radiusTop: 0, height: 20 } },
];

export function Toolbar() {
  const canUndo = useSceneStore(selectCanUndo);
  const canRedo = useSceneStore(selectCanRedo);
  const { undo, redo, dispatch, dispatchBatch } = useSceneStore.getState();
  const projectName = useProjectStore((s) => s.name);
  const dirty = useIsDirty();

  const add = (p: (typeof PRIMITIVES)[number]) => {
    const model = useSceneStore.getState().history.present.model;
    dispatch({ ...p.command, position: nextFreePosition(model, p.sizeX) });
  };

  const [tab, setTab] = useState<Tab>('feature');
  const drawTool = useEditorStore((s) => s.drawTool);
  const picking = useEditorStore((s) => s.pickingPlane);
  const pending = useEditorStore((s) => s.pending);
  // 솔리드웍스처럼 하는 일에 맞춰 탭이 따라온다: 그리기·평면 고르기 → 스케치, 피처 확정 대기 → 피처
  useEffect(() => {
    if (drawTool || picking) setTab('sketch');
  }, [drawTool, picking]);
  useEffect(() => {
    if (pending) setTab('feature');
  }, [pending]);
  const chatOpen = useEditorStore((s) => s.chatOpen);
  const displayMode = useEditorStore((s) => s.displayMode);
  const section = useEditorStore((s) => s.section);
  const measuring = useEditorStore((s) => s.measuring);
  const massOpen = useEditorStore((s) => s.massOpen);
  const projection = useEditorStore((s) => s.projection);
  const editor = useEditorStore.getState();
  const assemblyPanel = useEditorStore((s) => s.assemblyPanel);
  const assembly = (p: 'mate' | 'interference' | 'bom') => useEditorStore.getState().setAssemblyPanel(assemblyPanel === p ? null : p);
  const draw = (t: 'rectangle' | 'circle' | 'polygon' | 'path') => editor.setDrawTool(drawTool === t ? null : t);

  return (
    <header className="toolbar">
      {/* 1줄: 메뉴 (파일·실행 취소·내보내기·AI) */}
      <div className="menu-bar">
        <div className="brand">AI 3D Studio</div>
        <nav className="tools">
          <button onClick={() => void newProject()}>새 프로젝트</button>
          <button onClick={() => void openProject()} title="프로젝트 열기 (Ctrl+O)">
            열기
          </button>
          <button onClick={() => void saveProject()} title="프로젝트 저장 (Ctrl+S), 다른 이름으로: Ctrl+Shift+S">
            저장
          </button>
          <span className="sep" />
          <button onClick={undo} disabled={!canUndo} title="실행 취소 (Ctrl+Z)">
            실행 취소
          </button>
          <button onClick={redo} disabled={!canRedo} title="다시 실행 (Ctrl+Shift+Z)">
            다시 실행
          </button>
          <span className="sep" />
          <button onClick={() => void importMeshFile()} title="STL·OBJ·STEP 파일을 가져와 객체로 (다른 CAD·블렌더에서 만든 모델)" data-testid="import-mesh">
            가져오기
          </button>
          <ExportMenu />
        </nav>
        <div className="project-name" data-testid="project-name" title={dirty ? '저장하지 않은 변경 사항이 있습니다' : '저장됨'}>
          {projectName}
          {dirty && <span className="dirty"> •</span>}
        </div>
        <button className="ai-toggle" aria-pressed={chatOpen} onClick={editor.toggleChat} title="AI 설계 도우미 패널 열기/닫기">
          AI 도우미
        </button>
      </div>

      {/* 2줄: 명령 탭 (솔리드웍스식 CommandManager) */}
      <div className="command-tabs" role="tablist" aria-label="명령 탭">
        {TABS.map((t) => (
          <button key={t.id} role="tab" aria-selected={tab === t.id} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </div>
      <div className="command-bar" role="toolbar" aria-label={TABS.find((t) => t.id === tab)!.label}>
        {tab === 'feature' && (
          <>
            <Cmd icon="extrude" label="돌출 보스/베이스" title="선택한 스케치를 돌출 (속성 관리자에서 깊이 확인 후 ✓)" onClick={() => startFeature('extrude')} />
            <Cmd icon="revolve" label="회전 보스/베이스" title="선택한 스케치를 v 축 둘레로 회전" onClick={() => startFeature('revolve')} />
            <Cmd icon="extrudeCut" label="돌출 컷" title="선택한 스케치를 돌출해 바디에서 뺌 (면 위 스케치는 안쪽으로)" onClick={() => startFeature('extrude', true)} testId="cmd-extrude-cut" />
            <Cmd icon="sweep" label="스윕" title="단면을 경로를 따라 쓸기 (파이프·손잡이·레일)" onClick={openSweep} testId="cmd-sweep" />
            <Cmd icon="rib" label="리브" title="선택한 스케치의 경로·구성선을 두께 2mm 로 세우기 (보강대·얇은 벽, 속성에서 두께·높이)" onClick={quickRib} testId="cmd-rib" />
            <Cmd icon="loft" label="로프트" title="여러 스케치 단면을 순서대로 이어 형상 만들기" onClick={openLoft} testId="cmd-loft" />
            <Cmd icon="helix" label="헬릭스" title="선택한 스케치 단면을 나선으로 감기 (스프링·코일)" onClick={quickHelix} testId="cmd-helix" />
            <Cmd icon="thread" label="나사산" title="선택한 원통에 나사산(피치 1.5mm) 감아 합치기" onClick={() => quickThread()} testId="cmd-thread" />
            <Cmd icon="thread" label="암나사" title="선택한 구멍 벽에 나사 홈 파기 (ISO 보통 나사 피치)" onClick={quickInternalThread} testId="cmd-internal-thread" />
            <Cmd icon="revolveCut" label="회전 컷" title="선택한 스케치를 회전해 바디에서 뺌 (홈·구멍)" onClick={() => startFeature('revolve', true)} testId="cmd-revolve-cut" />
            <span className="sep" />
            <Cmd icon="hole" label="구멍 가공" title="선택한 객체의 윗면 중심에 구멍 (속성에서 위치·종류 조정)" onClick={quickHole} testId="cmd-hole" />
            <Cmd icon="fillet" label="필렛" title="선택한 객체의 모서리를 둥글게 (속성에서 반지름·모서리 규칙: 전체·세로·위·아래)" onClick={() => quickEdgeFeature('fillet')} testId="cmd-fillet" />
            <Cmd icon="chamfer" label="모따기" title="선택한 객체의 모서리를 비스듬히 깎기 (속성에서 거리·모서리 규칙)" onClick={() => quickEdgeFeature('chamfer')} testId="cmd-chamfer" />
            <Cmd icon="draft" label="구배" title="선택한 객체의 옆면을 바닥 기준으로 기울이기 (금형 빼기 각, 속성에서 각도)" onClick={quickDraft} testId="cmd-draft" />
            <Cmd icon="shell" label="쉘" title="선택한 박스·원통·돌출의 속을 비움 (윗면 열림)" onClick={quickShell} testId="cmd-shell" />
            <Cmd icon="linear" label="선형 패턴" title="선택한 객체를 X 방향으로 반복" onClick={() => quickPattern('linear')} testId="cmd-linear" />
            <Cmd icon="circular" label="원형 패턴" title="선택한 객체를 Z 축 둘레로 반복" onClick={() => quickPattern('circular')} testId="cmd-circular" />
            <Cmd icon="scale" label="크기 조정" title="선택한 객체를 원점 기준으로 늘리거나 줄임 (축별 배율)" onClick={quickScale} testId="cmd-scale" />
            <Cmd icon="mirror" label="대칭 복사" title="선택한 객체를 YZ 평면에 대칭 복사" onClick={() => quickPattern('mirror')} testId="cmd-mirror" />
            <span className="sep" />
            <span className="cmd-group-label">기본 도형</span>
            {PRIMITIVES.map((p) => (
              <button key={p.label} className="cmd small" onClick={() => add(p)}>
                + {p.label}
              </button>
            ))}
            <span className="sep" />
            <button
              className="cmd small"
              onClick={() => dispatchBatch(rectangleSketchCommands(useSceneStore.getState().history.present.model).commands)}
              title="XY 평면에 치수가 있는 사각형(60×40mm)을 바로 만듭니다 (빠른 시작)"
            >
              + 사각형 스케치
            </button>
          </>
        )}
        {tab === 'sketch' && (
          <>
            <Cmd icon="sketch" label="스케치" title="선택한 평면·객체 면에 스케치 시작 (없으면 평면을 고릅니다)" onClick={startSketch} testId="cmd-sketch" />
            <Cmd icon="sketchFace" label="면에 스케치" title="화면에서 평면(어느 형상의 면이든)을 클릭해 그 위에 스케치" onClick={startSketchOnFace} testId="cmd-sketch-face" />
            <span className="sep" />
            <Cmd icon="rectangle" label="사각형" shortcut="R" title="사각형 그리기 (R): 선택한 스케치에, 없으면 바닥(윗면)에 새 스케치" pressed={drawTool === 'rectangle'} onClick={() => draw('rectangle')} />
            <Cmd icon="circle" label="원" shortcut="C" title="원 그리기 (C): 중심 → 반지름 드래그" pressed={drawTool === 'circle'} onClick={() => draw('circle')} />
            <Cmd icon="slot" label="슬롯" title="선택한 스케치에 슬롯(긴 구멍) 추가" onClick={quickSlot} testId="cmd-slot" />
            <Cmd icon="line" label="구성선" title="선택한 스케치에 구성선(형상 없는 기준선) 추가 — 각도·평행 구속 기준" onClick={quickLine} testId="cmd-line" />
            <Cmd icon="polygon" label="다각형" shortcut="P" title="다각형 그리기 (P): 클릭으로 꼭짓점, 첫 점을 다시 클릭하거나 Enter 로 닫기" pressed={drawTool === 'polygon'} onClick={() => draw('polygon')} />
            <Cmd icon="path" label="경로" title="경로(열린 선) 그리기: 클릭으로 점, 마지막 점을 다시 클릭하거나 Enter 로 끝 — 스윕·리브 중심선" pressed={drawTool === 'path'} onClick={() => draw('path')} testId="cmd-path" />
            <span className="sep" />
            <span className="cmd-hint">구속(수평·수직·길이…)은 스케치를 선택하면 왼쪽 속성에 나옵니다</span>
          </>
        )}
        {tab === 'assembly' && (
          <>
            <Cmd icon="insert" label="부품 삽입" title="다른 프로젝트(.ai3d)를 부품으로 넣기 (복사본)" onClick={() => void insertPartFile()} testId="cmd-insert-part" />
            <Cmd icon="mate" label="메이트" title="부품끼리 면 일치·거리·평행·동심·각도·고정 (둘째로 고른 부품이 움직임)" onClick={() => assembly('mate')} testId="cmd-mate" pressed={assemblyPanel === 'mate'} />
            <Cmd icon="interference" label="간섭 검사" title="부품끼리 서로 파고든 부피 계산" onClick={() => assembly('interference')} testId="cmd-interference" pressed={assemblyPanel === 'interference'} />
            <Cmd icon="bom" label="부품표" title="부품 목록·수량 (같은 형상은 묶어 셈), CSV 저장" onClick={() => assembly('bom')} testId="cmd-bom" pressed={assemblyPanel === 'bom'} />
          </>
        )}
        {tab === 'view' && (
          <>
            {VIEWS.map((v) => (
              <Cmd key={v.name} icon={v.icon as IconName} label={v.label} title={`${v.label} (Ctrl+${v.key})`} onClick={() => editor.requestView(v.name)} />
            ))}
            <span className="sep" />
            {DISPLAY_MODES.map((d) => (
              <Cmd key={d.id} icon={d.icon} label={d.label} title={d.title} pressed={displayMode === d.id} onClick={() => editor.setDisplayMode(d.id)} testId={`display-${d.id}`} />
            ))}
            <span className="sep" />
            <Cmd icon="perspective" label={projection === 'perspective' ? '원근' : '직교'} title="원근 / 직교 투영 전환 (직교: 치수 확인·도면처럼 평행하게)" pressed={projection === 'orthographic'} onClick={editor.toggleProjection} testId="cmd-projection" />
            <Cmd icon="section" label="단면 보기" title="모델을 평면으로 잘라 안쪽을 봅니다" pressed={!!section} onClick={() => editor.setSection(section ? null : { axis: 'x', offset: 0, flip: false })} testId="cmd-section" />
            <Cmd icon="measure" label="측정" title="모델 위 두 점 사이 거리" pressed={measuring} onClick={editor.toggleMeasure} testId="cmd-measure" />
            <Cmd icon="mass" label="질량 특성" title="부피·겉넓이·무게 중심·질량(재료별)" pressed={massOpen} onClick={editor.toggleMass} testId="cmd-mass" />
            <Cmd icon="camera" label="이미지 저장" title="현재 화면을 PNG 로 저장" onClick={editor.requestScreenshot} testId="cmd-screenshot" />
            <span className="sep" />
            <Cmd icon="fit" label="화면 맞춤" shortcut="F" title="화면 맞춤 (F)" onClick={editor.requestFit} />
                      <Cmd icon="measureEntity" label="면·모서리 측정" title="면·모서리를 클릭해 길이·지름·거리·각도 재기" onClick={startMeasurePick} testId="cmd-measure-entity" />
          </>
        )}
      </div>
    </header>
  );
}

const DISPLAY_MODES = [
  { id: 'shadedEdges', label: '음영+모서리', icon: 'shadedEdges', title: '음영과 모서리 선' },
  { id: 'shaded', label: '음영', icon: 'shaded', title: '모서리 선 없이 음영만' },
  { id: 'wireframe', label: '와이어프레임', icon: 'wireframe', title: '삼각형 선만' },
  { id: 'xray', label: '투명', icon: 'xray', title: '반투명 (안쪽 구조 보기, 블렌더 X-ray)' },
] as const;

type Tab = 'feature' | 'sketch' | 'assembly' | 'view';
const TABS: { id: Tab; label: string }[] = [
  { id: 'feature', label: '피처' },
  { id: 'sketch', label: '스케치' },
  { id: 'assembly', label: '조립품' },
  { id: 'view', label: '보기' },
];
const VIEWS = [
  { name: 'front', label: '정면', key: 1, icon: 'front' },
  { name: 'top', label: '윗면', key: 5, icon: 'top' },
  { name: 'right', label: '우측면', key: 4, icon: 'right' },
  { name: 'iso', label: '등각', key: 7, icon: 'iso' },
  { name: 'normal', label: '스케치에 수직', key: 8, icon: 'normal' },
] as const;

/** 명령 버튼: 기호 + 이름 (솔리드웍스 CommandManager 처럼 큰 버튼) */
function Cmd(props: { icon: IconName; label: string; title: string; onClick: () => void; pressed?: boolean; testId?: string; shortcut?: string }) {
  return (
    <button className="cmd" title={props.title} aria-pressed={props.pressed} onClick={props.onClick} data-testid={props.testId}>
      <span className="cmd-icon" aria-hidden="true">
        <CmdIcon name={props.icon} />
      </span>
      <span className="cmd-label">
        {props.label}
        {props.shortcut && <kbd>{props.shortcut}</kbd>}
      </span>
    </button>
  );
}
