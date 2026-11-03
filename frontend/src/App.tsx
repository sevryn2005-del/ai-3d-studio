import { ChatPanel } from './components/ChatPanel/ChatPanel';
import { Viewport } from './components/Viewport/Viewport';
import { PropertyPanel } from './components/PropertyPanel/PropertyPanel';
import { Toolbar } from './components/Toolbar/Toolbar';
import { StatusBar } from './components/StatusBar/StatusBar';
import { ConfirmDialog } from './components/Dialogs/ConfirmDialog';
import { useKeyboardShortcuts } from './useKeyboardShortcuts';
import { useBackendSync } from './features/backend/useBackendSync';
import { useProjectLifecycle } from './features/projects/useProjectLifecycle';

export function App() {
  useKeyboardShortcuts();
  useBackendSync();
  useProjectLifecycle();
  return (
    <div className="app">
      <Toolbar />
      <main className="workspace">
        <ChatPanel />
        <Viewport />
        <PropertyPanel />
      </main>
      <StatusBar />
      <ConfirmDialog />
    </div>
  );
}
