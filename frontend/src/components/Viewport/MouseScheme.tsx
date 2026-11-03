import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { MOUSE } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useEditorStore } from '../../features/selection/editorStore';

/** OrbitControls 에서 아무 동작도 하지 않는 버튼 값 (선택 전용) */
const NONE = -1 as unknown as MOUSE;

/**
 * 마우스 방식 적용 (editorStore.mouseScheme).
 * - 솔리드웍스식: 가운데 드래그 = 회전, Ctrl + 가운데 = 이동, Shift + 가운데 = 확대/축소, 휠 = 확대/축소, 왼쪽·오른쪽 = 선택용
 * - 간편: 왼쪽 드래그 = 회전, 오른쪽 드래그 = 이동, 휠 = 확대/축소
 * Ctrl·Shift 조합은 OrbitControls 가 지원하지 않으므로 누르는 순간(캡처 단계)에 가운데 버튼의 동작을 바꿔 준다.
 * drawLocked: 그리기 도구 중에는 왼쪽 버튼을 그리기에 쓴다.
 */
export function MouseScheme({ drawLocked }: { drawLocked: boolean }) {
  const scheme = useEditorStore((s) => s.mouseScheme);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;
  const gl = useThree((s) => s.gl);

  useEffect(() => {
    if (!controls) return;
    controls.mouseButtons =
      scheme === 'solidworks'
        ? { LEFT: NONE, MIDDLE: MOUSE.ROTATE, RIGHT: NONE }
        : { LEFT: drawLocked ? NONE : MOUSE.ROTATE, MIDDLE: MOUSE.DOLLY, RIGHT: MOUSE.PAN };
    if (scheme !== 'solidworks') return;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 1) return;
      controls.mouseButtons.MIDDLE = e.ctrlKey ? MOUSE.PAN : e.shiftKey ? MOUSE.DOLLY : MOUSE.ROTATE;
    };
    gl.domElement.addEventListener('pointerdown', onDown, { capture: true });
    return () => gl.domElement.removeEventListener('pointerdown', onDown, { capture: true });
  }, [controls, gl, scheme, drawLocked]);

  return null;
}
