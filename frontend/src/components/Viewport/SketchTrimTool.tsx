import { useState } from 'react';
import { Line } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { DoubleSide, Matrix4 } from 'three';
import type { Point2 } from '../../cad/commandTypes';
import { selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { extendAt, trimAt, trimCommands, type TrimHit } from '../../cad/sketchTrim';
import { useActiveSketch } from '../../features/sketch/activeSketch';
import { useSketchView } from '../../features/sketch/sketchSettings';
import { useEditorStore } from '../../features/selection/editorStore';

/**
 * 잘라내기·연장 도구 (솔리드웍스 Trim / Extend): 구성선·경로 위에 커서를 올리면
 * 잘라낼 조각(빨강) 또는 늘일 선(초록 점선)이 보이고, 누르면 확정 (실행 취소 1번). Esc 로 끝.
 */
export function SketchTrimTool() {
  const tool = useEditorStore((s) => s.drawTool);
  const sketch = useSceneStore(selectSelectedSketch);
  const active = useActiveSketch();
  const mmPerPx = useSketchView((s) => s.mmPerPx);
  const [trim, setTrim] = useState<TrimHit | null>(null);
  const [ext, setExt] = useState<{ point: string; from: Point2; to: Point2 } | null>(null);
  if ((tool !== 'trim' && tool !== 'extend') || !sketch || !active) return null;
  const frame: Matrix4 = active.frame;
  const inverse = frame.clone().invert();
  const tol = mmPerPx * 10;
  const localOf = (e: ThreeEvent<PointerEvent>): Point2 => {
    const p = e.point.clone().applyMatrix4(inverse);
    return [p.x, p.y];
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    const p = localOf(e);
    if (tool === 'trim') setTrim(trimAt(sketch, p, tol));
    else setExt(extendAt(sketch, p, tol));
  };
  const down = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const p = localOf(e);
    const store = useSceneStore.getState();
    if (tool === 'trim') {
      const hit = trimAt(sketch, p, tol);
      if (!hit) return store.reportError('잘라내기: 구성선·경로 위를 누르세요 (호·둥근 모서리·스플라인이 있는 경로는 아직 안 됩니다)');
      store.dispatchBatch(trimCommands(sketch, hit));
      setTrim(null);
    } else {
      const hit = extendAt(sketch, p, tol);
      if (!hit) return store.reportError('연장: 구성선·경로 끝을 누르세요 (그 방향에 만나는 요소가 없으면 늘일 수 없습니다)');
      store.submitNow({ type: 'move_point', sketch: sketch.id, point: hit.point, to: hit.to });
      setExt(null);
    }
  };
  const z = 0.04;
  return (
    <group matrixAutoUpdate={false} matrix={frame}>
      <mesh onPointerMove={move} onPointerDown={down} onPointerLeave={() => (setTrim(null), setExt(null))} name="sketch-trim-plane">
        <planeGeometry args={[20000, 20000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      {tool === 'trim' && trim && (
        <Line points={[[...trim.piece[0], z], [...trim.piece[1], z]]} color="#e5484d" lineWidth={4} depthTest={false} raycast={() => null} name="trim-preview" />
      )}
      {tool === 'extend' && ext && (
        <Line points={[[...ext.from, z], [...ext.to, z]]} color="#2f9a4a" lineWidth={2} dashed dashSize={mmPerPx * 6} gapSize={mmPerPx * 4} depthTest={false} raycast={() => null} name="extend-preview" />
      )}
    </group>
  );
}
