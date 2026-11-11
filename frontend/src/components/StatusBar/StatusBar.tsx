import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { useBackendStore, type Evaluation } from '../../features/backend/backendStore';
import { useProjectStore } from '../../features/projects/projectStore';
import { getActiveEngine, useActiveEngineId } from '../../features/engine/engines';
import { appConfig } from '../../api/config';
import { PrintCheckStatus } from '../PrintCheck/PrintCheckStatus';
import { selectSelectedSketch } from '../../cad/sceneStore';
import { degreesOfFreedom } from '../../cad/solver';
import { explainError } from '../../features/errors/errorGuide';

export function StatusBar() {
  const model = useSceneStore(selectModel);
  const lastError = useSceneStore((s) => s.lastError);
  const clearError = useSceneStore((s) => s.clearError);
  const connection = useBackendStore((s) => s.connection);
  const evaluation = useBackendStore((s) => s.evaluation);
  const notice = useProjectStore((s) => s.notice);
  const engineId = useActiveEngineId();

  return (
    <footer className="statusbar">
      <span>단위: {model.units}</span>
      <span>객체: {model.objects.length}개</span>
      {appConfig().cadEngine !== 'browser' && (
        <span data-testid="server-status" className={`server ${connection}`}>
          ● 서버 {connection === 'online' ? '연결됨' : connection === 'offline' ? '오프라인' : '확인 중'}
        </span>
      )}
      <span data-testid="cad-engine" className="muted">
        CAD: {engineId ? getActiveEngine(engineId).label : '연결 확인 중'}
      </span>
      {engineId && <EvaluationStatus evaluation={evaluation} />}
      <PrintCheckStatus />
      <SketchState />
      {notice && (
        <span className="notice" role="status" data-testid="notice">
          {notice}
        </span>
      )}
      {lastError ? (
        <button className="status-error" onClick={clearError} title={`${lastError}\n(클릭하여 닫기)`} role="alert">
          ⚠ {explainError(lastError).title}
        </button>
      ) : (
        <span className="status-ok">● 설계 정상</span>
      )}
    </footer>
  );
}

function EvaluationStatus({ evaluation: e }: { evaluation: Evaluation }) {
  let text: string;
  let title: string | undefined;
  switch (e.status) {
    case 'idle':
      return null;
    case 'pending':
      text = '형상 계산 중…';
      break;
    case 'failed':
      text = '형상 계산 실패';
      title = e.error;
      break;
    case 'done':
      const who = e.result.engine === 'server' ? '서버 검증' : '브라우저 계산';
      if (e.result.ok) {
        text = `${who} ✓`;
        title = `CAD 계산 ${e.result.computeMs ?? '-'}ms`;
      } else {
        text = `${who}: 문제 ${e.result.issues.length}건`;
        title = e.result.issues.map((i) => `${i.path}: ${i.message}`).join('\n');
      }
  }
  return (
    <span data-testid="server-evaluation" className="muted" title={title}>
      {text}
    </span>
  );
}

/** 선택한 스케치의 정의 상태 (솔리드웍스 상태 표시줄의 "완전 정의 / 불충분 정의") */
function SketchState() {
  const sketch = useSceneStore(selectSelectedSketch);
  if (!sketch) return null;
  if (sketch.entities.length === 0)
    return (
      <span data-testid="sketch-state" className="sketch-under">
        {sketch.name}: 비어 있음 — 사각형·원·다각형을 그리세요
      </span>
    );
  const dof = degreesOfFreedom(sketch);
  return (
    <span data-testid="sketch-state" className={dof === 0 ? 'sketch-full' : 'sketch-under'}>
      {sketch.name}: {dof === 0 ? '완전 정의' : `불충분 정의 (자유도 ${dof})`}
    </span>
  );
}
