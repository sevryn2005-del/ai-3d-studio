import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { useBackendStore, type Evaluation } from '../../features/backend/backendStore';
import { useProjectStore } from '../../features/projects/projectStore';
import { getActiveEngine, useActiveEngineId } from '../../features/engine/engines';
import { appConfig } from '../../api/config';
import { PrintCheckStatus } from '../PrintCheck/PrintCheckStatus';

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
      {notice && (
        <span className="notice" role="status" data-testid="notice">
          {notice}
        </span>
      )}
      {lastError ? (
        <button className="status-error" onClick={clearError} title="클릭하여 닫기" role="alert">
          ⚠ {lastError}
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
