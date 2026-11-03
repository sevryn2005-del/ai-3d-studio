import { useEditorStore } from '../../features/selection/editorStore';

export function ViewportToolbar() {
  const mode = useEditorStore((s) => s.transformMode);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);
  const { setTransformMode, toggleSnap, requestFit } = useEditorStore.getState();

  return (
    <div className="viewport-toolbar" role="toolbar" aria-label="뷰포트 도구">
      <button aria-pressed={mode === 'translate'} onClick={() => setTransformMode('translate')} title="이동 (W)">
        이동 <kbd>W</kbd>
      </button>
      <button aria-pressed={mode === 'rotate'} onClick={() => setTransformMode('rotate')} title="회전 (E)">
        회전 <kbd>E</kbd>
      </button>
      <span className="sep" />
      <button aria-pressed={snapEnabled} onClick={toggleSnap} title="스냅: 1mm / 15° (S)">
        스냅 {snapEnabled ? '1mm·15°' : '끔'} <kbd>S</kbd>
      </button>
      <button onClick={requestFit} title="화면 맞춤 (F)">
        화면 맞춤 <kbd>F</kbd>
      </button>
    </div>
  );
}
