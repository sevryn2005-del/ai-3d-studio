import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Matrix4, Vector3 } from 'three';
import type { Point2 } from '../../cad/commandTypes';
import { selectModel, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { drawShapeCommands, sketchPlacement, type DrawnShape } from '../../cad/sketchActions';
import { planeMatrix } from '../../cad/sketchPlane';
import { toMatrix } from '../../cad/transformMath';
import { formatMm } from '../../cad/units';
import { selectSnap, useEditorStore } from '../../features/selection/editorStore';

/**
 * 뷰포트 직접 그리기 (사각형: 두 모서리 드래그, 원: 중심에서 드래그).
 * - 스케치를 선택한 상태면 그 스케치 평면에, 아니면 바닥(XY, z=0)에 새 스케치로 그린다.
 * - 드래그 중에는 미리보기만 (설계 원본 그대로). 놓을 때 명령 묶음 1건 → 실행 취소 1번.
 * - 그린 뒤에도 도구는 유지되고, 다음 도형은 같은 스케치에 추가된다. Esc 로 끝낸다.
 */
export function SketchDrawTool() {
  const tool = useEditorStore((s) => s.drawTool);
  const snap = useEditorStore(selectSnap);
  const model = useSceneStore(selectModel);
  const sketch = useSceneStore(selectSelectedSketch);
  const [drag, setDrag] = useState<{ from: Point2; to: Point2 } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;

  // 그리기 평면: 스케치 좌표 → 월드
  const frame = useMemo(() => {
    const placement = sketch ? toMatrix(sketchPlacement(model, sketch.id)) : new Matrix4();
    return placement.multiply(planeMatrix(sketch?.plane ?? { type: 'XY', offset: 0 }));
  }, [model, sketch]);
  const inverse = useMemo(() => frame.clone().invert(), [frame]);

  useEffect(() => setDrag(null), [tool, sketch?.id]);
  useEffect(() => {
    if (!tool) return;
    document.body.style.cursor = 'crosshair';
    return () => {
      document.body.style.cursor = '';
    };
  }, [tool]);

  if (!tool) return null;

  const step = snap.translation ?? 0.1;
  const toSketch = (world: Vector3): Point2 => {
    const p = world.clone().applyMatrix4(inverse);
    return [Math.round(p.x / step) * step, Math.round(p.y / step) * step];
  };
  const shapeOf = (d: { from: Point2; to: Point2 }): DrawnShape =>
    tool === 'rectangle'
      ? { type: 'rectangle', from: d.from, to: d.to }
      : { type: 'circle', center: d.from, radius: Math.round(Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) / step) * step };

  const down = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toSketch(e.point);
    setDrag({ from: p, to: p });
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    if (!dragRef.current) return;
    e.stopPropagation();
    setDrag({ from: dragRef.current.from, to: toSketch(e.point) });
  };
  const up = (e: ThreeEvent<PointerEvent>) => {
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    setDrag(null);
    const store = useSceneStore.getState();
    const cmds = drawShapeCommands(store.history.present.model, sketch?.id ?? null, shapeOf({ from: d.from, to: toSketch(e.point) }));
    if (cmds) store.dispatchBatch(cmds);
  };

  return (
    <group matrixAutoUpdate={false} matrix={frame}>
      {/* 포인터를 받는 보이지 않는 평면 (스케치 평면 위) */}
      <mesh onPointerDown={down} onPointerMove={move} onPointerUp={up} name="sketch-draw-plane">
        <planeGeometry args={[20000, 20000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      {drag && <DrawPreview shape={shapeOf(drag)} />}
    </group>
  );
}

function DrawPreview({ shape }: { shape: DrawnShape }) {
  const { geometry, label, anchor } = useMemo(() => {
    const pts: number[] = [];
    let label: string;
    let anchor: [number, number, number];
    if (shape.type === 'rectangle') {
      const [x0, y0] = shape.from;
      const [x1, y1] = shape.to;
      for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) pts.push(x, y, 0.03);
      label = `${formatMm(Math.abs(x1 - x0))} × ${formatMm(Math.abs(y1 - y0))} mm`;
      anchor = [x1, y1, 0];
    } else {
      const [cx, cy] = shape.center;
      for (let i = 0; i < 64; i++) {
        const a = (i / 64) * Math.PI * 2;
        pts.push(cx + shape.radius * Math.cos(a), cy + shape.radius * Math.sin(a), 0.03);
      }
      label = `Ø${formatMm(shape.radius * 2)} mm`;
      anchor = [cx + shape.radius, cy, 0];
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts, 3));
    return { geometry: g, label, anchor };
  }, [shape]);
  useEffect(() => () => geometry.dispose(), [geometry]);
  return (
    <>
      <lineLoop geometry={geometry} raycast={() => null}>
        <lineBasicMaterial color="#ffffff" depthTest={false} />
      </lineLoop>
      <Html position={anchor} style={{ pointerEvents: 'none' }}>
        <div className="draw-label" data-testid="draw-label">
          {label}
        </div>
      </Html>
    </>
  );
}
