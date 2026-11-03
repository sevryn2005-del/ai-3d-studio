import type { CreateCommand } from '../../cad/commandTypes';
import { nextFreePosition } from '../../cad/placement';
import { selectCanRedo, selectCanUndo, useSceneStore } from '../../cad/sceneStore';
import { useEffect, useState } from 'react';
import { CmdIcon, type IconName } from './CmdIcon';
import { ExportMenu } from './ExportMenu';
import { useEditorStore } from '../../features/selection/editorStore';
import { startFeature, startSketch } from '../../features/selection/featureFlow';
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
  const editor = useEditorStore.getState();
  const draw = (t: 'rectangle' | 'circle' | 'polygon') => editor.setDrawTool(drawTool === t ? null : t);

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
            <span className="sep" />
            <Cmd icon="rectangle" label="사각형" shortcut="R" title="사각형 그리기 (R): 선택한 스케치에, 없으면 바닥(윗면)에 새 스케치" pressed={drawTool === 'rectangle'} onClick={() => draw('rectangle')} />
            <Cmd icon="circle" label="원" shortcut="C" title="원 그리기 (C): 중심 → 반지름 드래그" pressed={drawTool === 'circle'} onClick={() => draw('circle')} />
            <Cmd icon="polygon" label="다각형" shortcut="P" title="다각형 그리기 (P): 클릭으로 꼭짓점, 첫 점을 다시 클릭하거나 Enter 로 닫기" pressed={drawTool === 'polygon'} onClick={() => draw('polygon')} />
            <span className="sep" />
            <span className="cmd-hint">구속(수평·수직·길이…)은 스케치를 선택하면 왼쪽 속성에 나옵니다</span>
          </>
        )}
        {tab === 'view' && (
          <>
            {VIEWS.map((v) => (
              <Cmd key={v.name} icon={v.icon as IconName} label={v.label} title={`${v.label} (Ctrl+${v.key})`} onClick={() => editor.requestView(v.name)} />
            ))}
            <Cmd icon="fit" label="화면 맞춤" shortcut="F" title="화면 맞춤 (F)" onClick={editor.requestFit} />
          </>
        )}
      </div>
    </header>
  );
}

type Tab = 'feature' | 'sketch' | 'view';
const TABS: { id: Tab; label: string }[] = [
  { id: 'feature', label: '피처' },
  { id: 'sketch', label: '스케치' },
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
