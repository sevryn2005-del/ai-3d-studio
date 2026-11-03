import type { CreateCommand } from '../../cad/commandTypes';
import { nextFreePosition } from '../../cad/placement';
import { selectCanRedo, selectCanUndo, useSceneStore } from '../../cad/sceneStore';
import { ExportMenu } from './ExportMenu';
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

  return (
    <header className="toolbar">
      <div className="brand">AI 3D Studio</div>
      <div className="project-name" data-testid="project-name" title={dirty ? '저장하지 않은 변경 사항이 있습니다' : '저장됨'}>
        {projectName}
        {dirty && <span className="dirty"> •</span>}
      </div>
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
        <span className="muted">추가</span>
        {PRIMITIVES.map((p) => (
          <button key={p.label} onClick={() => add(p)}>
            + {p.label}
          </button>
        ))}
        <button
          onClick={() => dispatchBatch(rectangleSketchCommands(useSceneStore.getState().history.present.model).commands)}
          title="XY 평면에 치수가 있는 사각형(60×40mm)을 그립니다. 속성 패널에서 치수를 바꾸고 돌출합니다."
        >
          + 사각형 스케치
        </button>
        <span className="sep" />
        <ExportMenu />
      </nav>
    </header>
  );
}
