import { useEditorStore } from '../../features/selection/editorStore';

export function ViewportToolbar() {
  const mode = useEditorStore((s) => s.transformMode);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);
  const drawTool = useEditorStore((s) => s.drawTool);
  const { setTransformMode, toggleSnap, requestFit, setDrawTool } = useEditorStore.getState();

  return (
    <div className="viewport-toolbar" role="toolbar" aria-label="뷰포트 도구">
      <button aria-pressed={!drawTool && mode === 'translate'} onClick={() => { setDrawTool(null); setTransformMode('translate'); }} title="이동 (W)">
        이동 <kbd>W</kbd>
      </button>
      <button aria-pressed={!drawTool && mode === 'rotate'} onClick={() => { setDrawTool(null); setTransformMode('rotate'); }} title="회전 (E)">
        회전 <kbd>E</kbd>
      </button>
      <span className="sep" />
      <button
        aria-pressed={drawTool === 'rectangle'}
        onClick={() => setDrawTool(drawTool === 'rectangle' ? null : 'rectangle')}
        title="사각형 그리기 (R): 선택한 스케치에, 없으면 바닥에 새 스케치"
      >
        사각형 <kbd>R</kbd>
      </button>
      <button
        aria-pressed={drawTool === 'circle'}
        onClick={() => setDrawTool(drawTool === 'circle' ? null : 'circle')}
        title="원 그리기 (C): 선택한 스케치에, 없으면 바닥에 새 스케치"
      >
        원 <kbd>C</kbd>
      </button>
      <button
        aria-pressed={drawTool === 'polygon'}
        onClick={() => setDrawTool(drawTool === 'polygon' ? null : 'polygon')}
        title="다각형 그리기 (P): 클릭으로 꼭짓점, 첫 점을 다시 클릭하거나 Enter 로 닫기. 치수는 구속으로 맞춥니다"
      >
        다각형 <kbd>P</kbd>
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
