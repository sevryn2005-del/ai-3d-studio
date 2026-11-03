import { useEffect, useState } from 'react';
import { useEditorStore, type ViewName } from '../../features/selection/editorStore';

const VIEW_MENU: { name: ViewName; label: string; key: string }[] = [
  { name: 'front', label: '정면', key: '1' },
  { name: 'back', label: '후면', key: '2' },
  { name: 'left', label: '좌측면', key: '3' },
  { name: 'right', label: '우측면', key: '4' },
  { name: 'top', label: '윗면', key: '5' },
  { name: 'bottom', label: '아랫면', key: '6' },
  { name: 'iso', label: '등각', key: '7' },
  { name: 'normal', label: '스케치에 수직', key: '8' },
];

export function ViewportToolbar() {
  const mode = useEditorStore((s) => s.transformMode);
  const snapEnabled = useEditorStore((s) => s.snapEnabled);
  const drawTool = useEditorStore((s) => s.drawTool);
  const mouseScheme = useEditorStore((s) => s.mouseScheme);
  const { setTransformMode, toggleSnap, requestFit, setDrawTool, setMouseScheme, requestView } = useEditorStore.getState();
  const [viewMenu, setViewMenu] = useState(false);
  useEffect(() => {
    const toggle = () => setViewMenu((v) => !v);
    window.addEventListener('ai3d:view-menu', toggle);
    return () => window.removeEventListener('ai3d:view-menu', toggle);
  }, []);

  return (
    <div className="viewport-toolbar" role="toolbar" aria-label="뷰포트 도구">
      <button aria-pressed={!drawTool && mode === 'translate'} onClick={() => { setDrawTool(null); setTransformMode('translate'); }} title="이동 (W)">
        이동 <kbd>W</kbd>
      </button>
      <button aria-pressed={!drawTool && mode === 'rotate'} onClick={() => { setDrawTool(null); setTransformMode('rotate'); }} title="회전 (E)">
        회전 <kbd>E</kbd>
      </button>
      <span className="sep" />
      <button aria-pressed={snapEnabled} onClick={toggleSnap} title="스냅: 1mm / 15° (S)">
        스냅 {snapEnabled ? '1mm·15°' : '끔'} <kbd>S</kbd>
      </button>
      <button aria-expanded={viewMenu} onClick={() => setViewMenu(!viewMenu)} title="보기 방향 (스페이스)" data-testid="view-menu-button">
        보기 ▾
      </button>
      <button
        onClick={() => setMouseScheme(mouseScheme === 'solidworks' ? 'simple' : 'solidworks')}
        title="마우스 방식 바꾸기 — 솔리드웍스식: 가운데 버튼 회전 / 간편: 왼쪽 버튼 회전(트랙패드)"
        data-testid="mouse-scheme"
      >
        마우스: {mouseScheme === 'solidworks' ? '솔리드웍스식' : '간편'}
      </button>
      {viewMenu && (
        <div className="view-menu" role="menu" aria-label="보기 방향">
          {VIEW_MENU.map((v) => (
            <button
              key={v.name}
              role="menuitem"
              onClick={() => {
                requestView(v.name);
                setViewMenu(false);
              }}
            >
              {v.label} <kbd>Ctrl+{v.key}</kbd>
            </button>
          ))}
        </div>
      )}
      <button onClick={requestFit} title="화면 맞춤 (F)">
        화면 맞춤 <kbd>F</kbd>
      </button>
    </div>
  );
}
