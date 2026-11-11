/**
 * 화면 한 부분이 그리다 고장 나도 앱 전체가 하얗게 멈추지 않게 (React 오류 경계).
 * 그 부분 자리에 안내 + "다시 그리기" · "방금 변경 취소 후 다시 그리기" — 대개 마지막 변경이 원인이라 되돌리면 살아난다.
 * 설계 원본과 자동 저장본은 그대로다.
 */
import { Component, type ErrorInfo, type ReactNode } from 'react';
import { useSceneStore } from '../../cad/sceneStore';
import { useNoticeStore } from '../../features/errors/noticeStore';
import { useDevCrash } from '../../features/errors/devCrash';

interface Props {
  /** 사람이 읽는 영역 이름 (예: "3D 뷰포트") */
  area: string;
  children: ReactNode;
}

export class ErrorBoundary extends Component<Props, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`[${this.props.area}]`, error, info.componentStack);
    useNoticeStore.getState().report(`${this.props.area}: ${error.message}`, 'unexpected');
  }

  private retry = () => {
    useDevCrash.getState().set(false);
    this.setState({ error: null });
  };
  private undoAndRetry = () => {
    useSceneStore.getState().undo();
    this.retry();
  };

  render() {
    if (!this.state.error) return this.props.children;
    const canUndo = useSceneStore.getState().history.past.length > 0;
    return (
      <section className="panel crash-card" role="alert" data-testid="crash-card">
        <strong>{this.props.area}을(를) 그리다 문제가 생겼습니다</strong>
        <p className="muted">설계와 자동 저장본은 그대로입니다. 보통 방금 한 변경 때문이라 되돌리면 다시 보입니다.</p>
        <div className="crash-actions">
          {canUndo && (
            <button className="ok" onClick={this.undoAndRetry} data-testid="crash-undo">
              방금 변경 취소 후 다시 그리기
            </button>
          )}
          <button onClick={this.retry} data-testid="crash-retry">
            다시 그리기
          </button>
        </div>
        <details>
          <summary className="muted small">자세히</summary>
          <pre className="notice-raw">{this.state.error.message}</pre>
        </details>
      </section>
    );
  }
}
