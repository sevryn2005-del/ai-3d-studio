import { useEffect, useMemo, useRef, useState } from 'react';
import { Html } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Line, LineBasicMaterial, Matrix4, Vector3 } from 'three';
import type { Point2 } from '../../cad/commandTypes';
import { selectModel, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { drawShapeCommands, type DrawnShape } from '../../cad/sketchActions';
import { sketchWorldMatrix } from '../../cad/sketchPlane';
import { formatMm } from '../../cad/units';
import { bulgeArc, bulgeThrough, sampleSegments } from '../../cad/curves';
import { selectSnap, useEditorStore } from '../../features/selection/editorStore';

/**
 * 뷰포트 직접 그리기 (사각형: 두 모서리 드래그, 원: 중심에서 드래그,
 * 다각형: 클릭으로 꼭짓점, 첫 점을 다시 클릭하거나 Enter 로 닫기 — 모양은 이후 구속으로 정확히 맞춘다).
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
  const [poly, setPoly] = useState<Point2[]>([]);
  const [hover, setHover] = useState<Point2 | null>(null);
  const polyRef = useRef(poly);
  polyRef.current = poly;

  // 그리기 평면: 스케치 좌표 → 월드
  const frame = useMemo(() => {
    return (sketch && sketchWorldMatrix(model, sketch)) || new Matrix4(); // 스케치가 없으면 바닥(XY, z=0)
  }, [model, sketch]);
  const inverse = useMemo(() => frame.clone().invert(), [frame]);

  useEffect(() => {
    setDrag(null);
    setPoly([]);
  }, [tool, sketch?.id]);
  const multi = tool === 'polygon' || tool === 'path' || tool === 'arc' || tool === 'spline';
  const finishArc = (from: Point2, to: Point2, through: Point2) => {
    setPoly([]);
    const store = useSceneStore.getState();
    const sid = store.history.present.model.sketches.some((k) => k.id === sketch?.id) ? sketch!.id : null;
    const cmds = drawShapeCommands(store.history.present.model, sid, { type: 'arc', from, to, through });
    if (cmds) {
      store.dispatchBatch(cmds);
      if (bulgeThrough(from, to, through)?.clamped) store.reportError('반원보다 큰 호는 반원으로 그렸습니다 (호를 두 개로 나눠 그리세요)');
    } else store.reportError('호를 만들 수 없습니다 (세 점이 한 직선 위에 있거나 너무 짧습니다)');
  };
  /** 다각형·경로 끝내기. 스플라인 도구: 첫 점을 다시 누르면 닫힌 스플라인, Enter·마지막 점 다시 누르면 열린 스플라인 */
  const finishPolygon = (points: Point2[], closed = tool === 'polygon') => {
    setPoly([]);
    const store = useSceneStore.getState();
    const type = closed ? 'polygon' : 'path';
    const cmds = drawShapeCommands(store.history.present.model, store.history.present.model.sketches.some((k) => k.id === sketch?.id) ? sketch!.id : null, { type, points, spline: tool === 'spline' });
    if (cmds) store.dispatchBatch(cmds);
    else store.reportError(type === 'path' ? '경로를 만들 수 없습니다 (같은 점이 겹치거나 되돌아갑니다)' : '다각형을 만들 수 없습니다 (변이 교차하거나 넓이가 없습니다)');
  };
  useEffect(() => {
    if (!multi) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Enter' && polyRef.current.length >= (tool === 'polygon' ? 3 : 2)) {
        e.preventDefault();
        finishPolygon(polyRef.current);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
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
  const shapeOf = (d: { from: Point2; to: Point2 }): Exclude<DrawnShape, { type: 'polygon' | 'path' | 'arc' }> =>
    tool === 'rectangle'
      ? { type: 'rectangle', from: d.from, to: d.to }
      : { type: 'circle', center: d.from, radius: Math.round(Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]) / step) * step };

  const down = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (multi) {
      const p = toSketch(e.point);
      const pts = polyRef.current;
      const first = pts[0];
      const last = pts.at(-1);
      const near = (q: Point2 | undefined) => !!q && Math.hypot(p[0] - q[0], p[1] - q[1]) <= Math.max(1.5 * step, 1);
      // 호: 시작 → 끝 → 호 위의 점 (세 번째 클릭에서 끝)
      if (tool === 'arc' && pts.length === 2) return finishArc(pts[0]!, pts[1]!, p);
      // 다각형: 첫 점을 다시 누르면 닫힘. 경로: 마지막 점을 다시 누르면 끝 (열린 선)
      if (tool === 'polygon' && pts.length >= 3 && near(first)) return finishPolygon(pts);
      if (tool === 'path' && pts.length >= 2 && near(last)) return finishPolygon(pts);
      if (tool === 'spline' && pts.length >= 3 && near(first)) return finishPolygon(pts, true);
      if (tool === 'spline' && pts.length >= 2 && near(last)) return finishPolygon(pts, false);
      if (!last || last[0] !== p[0] || last[1] !== p[1]) setPoly([...pts, p]);
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    const p = toSketch(e.point);
    setDrag({ from: p, to: p });
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    if (multi) {
      setHover(toSketch(e.point));
      return;
    }
    if (!dragRef.current) return;
    e.stopPropagation();
    setDrag({ from: dragRef.current.from, to: toSketch(e.point) });
  };
  const up = (e: ThreeEvent<PointerEvent>) => {
    if (multi) return;
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
      {multi && poly.length > 0 && tool !== 'arc' && <PolylinePreview points={hover ? [...poly, hover] : poly} count={poly.length} />}
      {tool === 'arc' && poly.length > 0 && <ArcPreview points={poly} hover={hover} />}
    </group>
  );
}

function DrawPreview({ shape }: { shape: Exclude<DrawnShape, { type: 'polygon' | 'path' | 'arc' }> }) {
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
        <lineBasicMaterial color="#1c232e" depthTest={false} />
      </lineLoop>
      <Html position={anchor} style={{ pointerEvents: 'none' }}>
        <div className="draw-label" data-testid="draw-label">
          {label}
        </div>
      </Html>
    </>
  );
}

/** 그리는 중인 호: 시작점 → (끝점) → 커서. 점 둘을 찍은 뒤에는 커서를 지나는 호를 보여 준다 */
function ArcPreview({ points, hover }: { points: Point2[]; hover: Point2 | null }) {
  const line = useMemo(() => {
    let pts: Point2[] = hover ? [...points, hover] : points;
    if (points.length === 2 && hover) {
      const arc = bulgeThrough(points[0]!, points[1]!, hover);
      if (arc) pts = sampleSegments([bulgeArc(points[0]!, points[1]!, arc.bulge)], false);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts.flatMap(([x, y]) => [x, y, 0.03]), 3));
    const l = new Line(g, new LineBasicMaterial({ color: '#ffd166', depthTest: false }));
    l.raycast = () => {};
    return l;
  }, [points, hover]);
  useEffect(() => () => {
    line.geometry.dispose();
    (line.material as LineBasicMaterial).dispose();
  }, [line]);
  const last = hover ?? points.at(-1)!;
  return (
    <>
      <primitive object={line} />
      <Html position={[last[0], last[1], 0]} style={{ pointerEvents: 'none' }}>
        <div className="draw-label" data-testid="draw-label">
          {points.length === 1 ? '끝점을 클릭하세요' : '호가 지날 점을 클릭하세요'}
        </div>
      </Html>
    </>
  );
}

/** 그리는 중인 다각형: 찍은 꼭짓점 + 커서까지의 선 */
function PolylinePreview({ points, count }: { points: Point2[]; count: number }) {
  // <line> 은 JSX 에서 SVG 요소와 이름이 겹치므로 Three.js Line 객체를 직접 만든다
  const line = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(points.flatMap(([x, y]) => [x, y, 0.03]), 3));
    const l = new Line(g, new LineBasicMaterial({ color: '#ffd166', depthTest: false }));
    l.raycast = () => {};
    return l;
  }, [points]);
  useEffect(() => () => {
    line.geometry.dispose();
    (line.material as LineBasicMaterial).dispose();
  }, [line]);
  const last = points.at(-1)!;
  return (
    <>
      <primitive object={line} />
      <Html position={[last[0], last[1], 0]} style={{ pointerEvents: 'none' }}>
        <div className="draw-label" data-testid="draw-label">
          꼭짓점 {count}개{count >= 3 ? ' · 첫 점 클릭 또는 Enter 로 닫기' : ''}
        </div>
      </Html>
    </>
  );
}
