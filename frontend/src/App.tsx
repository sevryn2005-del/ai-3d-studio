import { ChatPanel } from './components/ChatPanel/ChatPanel';
import { Viewport } from './components/Viewport/Viewport';
import { PropertyPanel } from './components/PropertyPanel/PropertyPanel';
import { Toolbar } from './components/Toolbar/Toolbar';
import { StatusBar } from './components/StatusBar/StatusBar';
import { ConfirmDialog } from './components/Dialogs/ConfirmDialog';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useEditorStore } from './features/selection/editorStore';
import { useBackendSync } from './features/backend/useBackendSync';
import { useProjectLifecycle } from './features/projects/useProjectLifecycle';
import { useAppScreen } from './features/projects/appScreen';
import { HomeScreen } from './components/Home/HomeScreen';
import { ModelingWorkspace } from './components/Modeling/ModelingWorkspace';
import { useSceneStore } from './cad/sceneStore';
import { ErrorBoundary } from './components/Errors/ErrorBoundary';
import { Notices } from './components/Errors/Notices';
import { useGlobalErrors } from './features/errors/useGlobalErrors';

export function App() {
  const screen = useAppScreen((s) => s.screen);
  useGlobalErrors();
  if (screen === 'home')
    return (
      <>
        <ErrorBoundary area="시작 화면">
          <HomeScreen />
        </ErrorBoundary>
        <ConfirmDialog />
        <Notices />
      </>
    );
  return <Editor />;
}

function Editor() {
  const chatOpen = useEditorStore((s) => s.chatOpen);
  useKeyboardShortcuts();
  useBackendSync();
  useProjectLifecycle();
  const workspace = useSceneStore((s) => s.history.present.model.workspace);
  if (workspace === 'modeling')
    return (
      <div className="app modeling">
        <ErrorBoundary area="도구 막대">
          <Toolbar />
        </ErrorBoundary>
        <ErrorBoundary area="3D 모델링 화면">
          <ModelingWorkspace />
        </ErrorBoundary>
        <StatusBar />
        <ConfirmDialog />
        <Notices />
      </div>
    );
  return (
    <div className="app">
      <ErrorBoundary area="도구 막대">
        <Toolbar />
      </ErrorBoundary>
      {/* 솔리드웍스식 배치: 왼쪽 피처 트리·속성 / 가운데 그래픽 영역 / 오른쪽 작업창(AI 도우미, 접을 수 있음) */}
      <main className={`workspace${chatOpen ? '' : ' no-chat'}`}>
        <ErrorBoundary area="피처 트리·속성">
          <PropertyPanel />
        </ErrorBoundary>
        <ErrorBoundary area="3D 뷰포트">
          <Viewport />
        </ErrorBoundary>
        {chatOpen && (
          <ErrorBoundary area="AI 도우미">
            <ChatPanel />
          </ErrorBoundary>
        )}
      </main>
      <StatusBar />
      <ConfirmDialog />
      <Notices />
    </div>
  );
}
