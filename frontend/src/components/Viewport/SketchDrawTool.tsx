import { useEffect, useMemo, useRef, useState } from 'react';
import { Html, Line as DreiLine } from '@react-three/drei';
import type { ThreeEvent } from '@react-three/fiber';
import { BufferGeometry, DoubleSide, Float32BufferAttribute, Line, LineBasicMaterial, Matrix4, Vector3 } from 'three';
import type { CadCommand, Point2 } from '../../cad/commandTypes';
import { centerRelations, drawnTarget, polylineRelations, rectRelations, withRelations, type PlacedMeta, type Relation } from '../../cad/autoRelations';
import { notify } from '../../features/projects/projectActions';
import { selectModel, selectSelectedSketch, useSceneStore } from '../../cad/sceneStore';
import { drawShapeCommands, type DrawnShape } from '../../cad/sketchActions';
import { sketchWorldMatrix } from '../../cad/sketchPlane';
import { formatMm } from '../../cad/units';
import { bulgeArc, bulgeThrough, sampleSegments } from '../../cad/curves';
import { useEditorStore } from '../../features/selection/editorStore';
import { SNAP_LABEL, sketchSnapPoints, snapSketchPoint, type SnapResult } from '../../cad/sketchSnap';
import { drawStep, useSketchView } from '../../features/sketch/sketchSettings';

/**
 * 뷰포트 직접 그리기 (사각형: 두 모서리 드래그, 원: 중심에서 드래그,
 * 다각형: 클릭으로 꼭짓점, 첫 점을 다시 클릭하거나 Enter 로 닫기 — 모양은 이후 구속으로 정확히 맞춘다).
 * - 스케치를 선택한 상태면 그 스케치 평면에, 아니면 바닥(XY, z=0)에 새 스케치로 그린다.
 * - 드래그 중에는 미리보기만 (설계 원본 그대로). 놓을 때 명령 묶음 1건 → 실행 취소 1번.
 * - 그린 뒤에도 도구는 유지되고, 다음 도형은 같은 스케치에 추가된다. Esc 로 끝낸다.
 */
export function SketchDrawTool() {
  const tool = useEditorStore((s) => s.drawTool);
  const model = useSceneStore(selectModel);
  const sketch = useSceneStore(selectSelectedSketch);
  const view = useSketchView();
  const [drag, setDrag] = useState<{ from: Point2; to: Point2; fromSnap: SnapResult } | null>(null);
  const dragRef = useRef(drag);
  dragRef.current = drag;
  // 찍은 점 + 그 점이 어디에 붙었는지·숫자로 친 길이 (자동 구속)
  const [placed, setPlaced] = useState<{ p: Point2; m: PlacedMeta }[]>([]);
  const placedRef = useRef(placed);
  placedRef.current = placed;
  const poly = useMemo(() => placed.map((x) => x.p), [placed]);
  const polyRef = useRef(poly);
  polyRef.current = poly;
  const [hover, setHover] = useState<SnapResult | null>(null);
  const hoverRef = useRef(hover);
  hoverRef.current = hover;
  /** 숫자 입력 (솔리드웍스·캐드처럼 그리는 중 길이를 친다): 칸들과 지금 칸 */
  const [typed, setTyped] = useState<{ fields: string[]; active: number } | null>(null);
  const typedRef = useRef(typed);
  typedRef.current = typed;

  // 그리기 평면: 스케치 좌표 → 월드
  const frame = useMemo(() => {
    return (sketch && sketchWorldMatrix(model, sketch)) || new Matrix4(); // 스케치가 없으면 바닥(XY, z=0)
  }, [model, sketch]);
  const inverse = useMemo(() => frame.clone().invert(), [frame]);
  // 붙을 점: 원점 + 스케치 요소의 끝점·중심·중간점·사분점 + 지금 찍은 점들
  const snapPoints = useMemo(() => sketchSnapPoints(sketch, poly), [sketch, poly]);

  useEffect(() => {
    setDrag(null);
    setPlaced([]);
    setHover(null);
    setTyped(null);
  }, [tool, sketch?.id]);
  const multi = tool === 'polygon' || tool === 'path' || tool === 'arc' || tool === 'spline';
  const viewRef = useRef(view);
  viewRef.current = view;

  /** 명령 묶음 + 자동 구속 → 한 번에 (실행 취소 1번) */
  const commit = (cmds: CadCommand[], rels: (entity: string) => Relation[]) => {
    const store = useSceneStore.getState();
    const target = drawnTarget(cmds);
    if (viewRef.current.autoRelations && target) {
      const { commands, added } = withRelations(store.history.present.model, cmds, target.sketch, rels(target.entity));
      const r = store.dispatchBatch(commands);
      if (r.ok && added > 0) notify(`자동 구속 ${added}개를 넣었습니다 (속성에서 확인·삭제)`);
      return r.ok;
    }
    return store.dispatchBatch(cmds).ok;
  };
  const sketchIdNow = () => {
    const m = useSceneStore.getState().history.present.model;
    return m.sketches.some((k) => k.id === sketch?.id) ? sketch!.id : null;
  };
  const finishArc = (pts: { p: Point2; m: PlacedMeta }[], through: Point2) => {
    setPlaced([]);
    const [from, to] = [pts[0]!.p, pts[1]!.p];
    const store = useSceneStore.getState();
    const cmds = drawShapeCommands(store.history.present.model, sketchIdNow(), { type: 'arc', from, to, through });
    if (cmds) {
      commit(cmds, (id) => polylineRelations(id, [from, to], pts.map((x) => x.m), { closed: false, straight: false }));
      if (bulgeThrough(from, to, through)?.clamped) store.reportError('반원보다 큰 호는 반원으로 그렸습니다 (호를 두 개로 나눠 그리세요)');
    } else store.reportError('호를 만들 수 없습니다 (세 점이 한 직선 위에 있거나 너무 짧습니다)');
  };
  /** 다각형·경로 끝내기. 스플라인 도구: 첫 점을 다시 누르면 닫힌 스플라인, Enter·마지막 점 다시 누르면 열린 스플라인 */
  const finishPolygon = (pts: { p: Point2; m: PlacedMeta }[], closed = tool === 'polygon') => {
    setPlaced([]);
    setTyped(null);
    const store = useSceneStore.getState();
    const type = closed ? 'polygon' : 'path';
    const points = pts.map((x) => x.p);
    const cmds = drawShapeCommands(store.history.present.model, sketchIdNow(), { type, points, spline: tool === 'spline' });
    if (cmds) commit(cmds, (id) => polylineRelations(id, points, pts.map((x) => x.m), { closed, straight: tool !== 'spline' }));
    else store.reportError(type === 'path' ? '경로를 만들 수 없습니다 (같은 점이 겹치거나 되돌아갑니다)' : '다각형을 만들 수 없습니다 (변이 교차하거나 넓이가 없습니다)');
  };

  /** 숫자 입력 칸 (도구마다) */
  const typedFields = (): string[] | null => {
    if (tool === 'rectangle' || tool === 'ellipse') return ['폭', '높이'];
    if (tool === 'circle') return ['지름'];
    if (tool === 'polygon' || tool === 'path' || tool === 'spline') return polyRef.current.length ? ['길이', '각도'] : null;
    return null;
  };
  /** 입력한 숫자로 다음 점 (다각형·경로): 앞 점에서 길이, 각도(비우면 지금 커서 방향) */
  const typedNext = (t: { fields: string[] }): { p: Point2; length: number } | null => {
    const last = polyRef.current.at(-1);
    const L = Number(t.fields[0]);
    if (!last || !(L > 0)) return null;
    let ang: number;
    if (t.fields[1] !== undefined && t.fields[1] !== '' && Number.isFinite(Number(t.fields[1]))) ang = Number(t.fields[1]);
    else {
      const h = hoverRef.current?.point;
      ang = h && (h[0] !== last[0] || h[1] !== last[1]) ? (Math.atan2(h[1] - last[1], h[0] - last[0]) * 180) / Math.PI : 0;
    }
    const a = (ang * Math.PI) / 180;
    const r6 = (v: number) => Number(v.toFixed(6)) + 0;
    return { p: [r6(last[0] + L * Math.cos(a)), r6(last[1] + L * Math.sin(a))], length: L };
  };
  /** 사각형·타원·원: 기준점(드래그 시작 또는 커서) + 입력한 크기 */
  const typedShape = (t: { fields: string[] }): { shape: Exclude<DrawnShape, { type: 'polygon' | 'path' | 'arc' }>; anchor: SnapResult | null } | null => {
    const d = dragRef.current;
    const anchor = d?.fromSnap ?? hoverRef.current;
    if (!anchor) return null;
    const a = anchor.point;
    if (tool === 'circle') {
      const D = Number(t.fields[0]);
      return D > 0 ? { shape: { type: 'circle', center: a, radius: D / 2 }, anchor } : null;
    }
    const W = Number(t.fields[0]);
    const H = t.fields[1] ? Number(t.fields[1]) : W;
    if (!(W > 0) || !(H > 0)) return null;
    const sx = d ? Math.sign(d.to[0] - d.from[0]) || 1 : 1;
    const sy = d ? Math.sign(d.to[1] - d.from[1]) || 1 : 1;
    return { shape: { type: tool as 'rectangle' | 'ellipse', from: a, to: [a[0] + sx * W, a[1] + sy * H] }, anchor };
  };
  const applyTyped = () => {
    const t = typedRef.current;
    if (!t) return;
    if (multi) {
      const n = typedNext(t);
      if (!n) return useSceneStore.getState().reportError('길이를 0보다 크게 입력하세요');
      setPlaced([...placedRef.current, { p: n.p, m: { length: n.length } }]);
      setTyped(null);
      return;
    }
    const r = typedShape(t);
    if (!r) return useSceneStore.getState().reportError('크기를 0보다 크게 입력하세요');
    setTyped(null);
    setDrag(null);
    const cmds = drawShapeCommands(useSceneStore.getState().history.present.model, sketchIdNow(), r.shape);
    const anchorSnap = r.anchor ? metaOf(r.anchor).snap : undefined;
    if (cmds)
      commit(cmds, (id) =>
        r.shape.type === 'circle' ? centerRelations(id, anchorSnap) : r.shape.type === 'rectangle' ? rectRelations(id, r.shape.from, r.shape.to, anchorSnap, undefined) : [],
      );
  };

  useEffect(() => {
    if (!tool || tool === 'trim' || tool === 'extend' || tool === 'dimension') return;
    // 캡처 단계: 전역 단축키(Esc = 그리기 끝, Enter = 확인)보다 먼저 받는다
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = typedRef.current;
      const stop = () => {
        e.preventDefault();
        e.stopImmediatePropagation();
      };
      if (/^[0-9.]$/.test(e.key) || (e.key === '-' && t)) {
        const fields = t?.fields ?? typedFields();
        if (!fields) return;
        stop();
        const cur = t ?? { fields: fields.map(() => ''), active: 0 };
        const f = [...cur.fields];
        const v = f[cur.active]!;
        if (e.key === '-') f[cur.active] = v.startsWith('-') ? v.slice(1) : '-' + v;
        else if (!(e.key === '.' && v.includes('.'))) f[cur.active] = v + e.key;
        setTyped({ fields: f, active: cur.active });
        return;
      }
      if (t) {
        if (e.key === 'Tab') {
          stop();
          setTyped({ ...t, active: (t.active + 1) % t.fields.length });
        } else if (e.key === 'Backspace') {
          stop();
          const f = [...t.fields];
          f[t.active] = f[t.active]!.slice(0, -1);
          setTyped(f.every((x) => x === '') ? null : { ...t, fields: f });
        } else if (e.key === 'Escape') {
          stop();
          setTyped(null);
        } else if (e.key === 'Enter') {
          stop();
          applyTyped();
        }
        return;
      }
      if (!multi) return;
      if (e.key === 'Enter' && polyRef.current.length >= (tool === 'polygon' ? 3 : 2)) {
        stop();
        finishPolygon(placedRef.current);
      } else if (e.key === 'Backspace' && polyRef.current.length > 0) {
        // 마지막으로 찍은 점 지우기 (그리는 도중 실수 고치기)
        stop();
        setPlaced(placedRef.current.slice(0, -1));
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  });
  useEffect(() => {
    if (!tool) return;
    document.body.style.cursor = 'crosshair';
    return () => {
      document.body.style.cursor = '';
    };
  }, [tool]);

  if (!tool || tool === 'trim' || tool === 'extend' || tool === 'dimension') return null;

  const step = drawStep(view);
  const tol = view.mmPerPx * SNAP_PX;
  /** 월드 점 → 스케치 좌표 + 스냅 (Shift: 다각형·경로는 앞 점에서 15° 각도) */
  const snapAt = (world: Vector3, shift: boolean): SnapResult => {
    const p = world.clone().applyMatrix4(inverse);
    const anchor = shift && multi && tool !== 'arc' ? polyRef.current.at(-1) : null;
    return snapSketchPoint([p.x, p.y], snapPoints, { tol, grid: view.gridSnap ? step : null, inference: view.inference, angleFrom: anchor, angleStep: 15 });
  };
  /** Shift: 사각형 → 정사각형, 타원 → 원 모양 (두 변 같게) */
  const square = (from: Point2, to: Point2, shift: boolean): Point2 => {
    if (!shift || (tool !== 'rectangle' && tool !== 'ellipse')) return to;
    const d = Math.max(Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
    return [from[0] + Math.sign(to[0] - from[0] || 1) * d, from[1] + Math.sign(to[1] - from[1] || 1) * d];
  };
  const shapeOf = (d: { from: Point2; to: Point2 }, exact = false): Exclude<DrawnShape, { type: 'polygon' | 'path' | 'arc' }> => {
    if (tool === 'rectangle' || tool === 'ellipse') return { type: tool, from: d.from, to: d.to };
    const r = Math.hypot(d.to[0] - d.from[0], d.to[1] - d.from[1]);
    // 다른 점에 붙었으면 그 점을 지나는 원 (정확히), 아니면 반지름을 격자로
    return { type: 'circle', center: d.from, radius: exact ? Number(r.toFixed(6)) : Math.round(r / step) * step };
  };
  const isPointSnap = (r: SnapResult | null) => !!r && r.kind !== 'grid' && r.kind !== 'free';
  const metaOf = (r: SnapResult): PlacedMeta => ({ snap: { kind: r.kind, guides: r.guides, ...(r.ref ? { ref: r.ref } : {}), ...(r.edge ? { edge: r.edge } : {}) } });

  const down = (e: ThreeEvent<PointerEvent>) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    if (typedRef.current) setTyped(null); // 클릭하면 입력 중인 숫자는 버리고 마우스로
    const r = snapAt(e.point, e.nativeEvent.shiftKey);
    const p = r.point;
    if (multi) {
      const pts = placedRef.current;
      const first = pts[0]?.p;
      const last = pts.at(-1)?.p;
      const near = (q: Point2 | undefined) => !!q && Math.hypot(p[0] - q[0], p[1] - q[1]) <= Math.max(tol, 1e-6);
      // 호: 시작 → 끝 → 호 위의 점 (세 번째 클릭에서 끝)
      if (tool === 'arc' && pts.length === 2) return finishArc(pts, p);
      // 다각형: 첫 점을 다시 누르면 닫힘. 경로: 마지막 점을 다시 누르면 끝 (열린 선)
      if (tool === 'polygon' && pts.length >= 3 && near(first)) return finishPolygon(pts);
      if (tool === 'path' && pts.length >= 2 && near(last)) return finishPolygon(pts);
      if (tool === 'spline' && pts.length >= 3 && near(first)) return finishPolygon(pts, true);
      if (tool === 'spline' && pts.length >= 2 && near(last)) return finishPolygon(pts, false);
      if (!last || last[0] !== p[0] || last[1] !== p[1]) setPlaced([...pts, { p, m: metaOf(r) }]);
      return;
    }
    (e.target as Element).setPointerCapture?.(e.pointerId);
    setDrag({ from: p, to: p, fromSnap: r });
  };
  const move = (e: ThreeEvent<PointerEvent>) => {
    const r = snapAt(e.point, e.nativeEvent.shiftKey);
    const d = dragRef.current;
    if (d && !multi) {
      e.stopPropagation();
      const to = square(d.from, r.point, e.nativeEvent.shiftKey);
      setHover({ ...r, point: to });
      setDrag({ ...d, to });
      return;
    }
    setHover(r);
  };
  const up = (e: ThreeEvent<PointerEvent>) => {
    if (multi) return;
    const d = dragRef.current;
    if (!d) return;
    e.stopPropagation();
    setDrag(null);
    if (typedRef.current) return; // 숫자를 치는 중이면 Enter 로 확정
    const r = snapAt(e.point, e.nativeEvent.shiftKey);
    const to = square(d.from, r.point, e.nativeEvent.shiftKey);
    const cmds = drawShapeCommands(useSceneStore.getState().history.present.model, sketch?.id ?? null, shapeOf({ from: d.from, to }, isPointSnap(r)));
    // 끝 모서리는 정사각형(Shift)으로 바뀌지 않았을 때만 붙은 점을 쓴다
    const toSnap = to[0] === r.point[0] && to[1] === r.point[1] ? metaOf(r).snap : undefined;
    if (cmds)
      commit(cmds, (id) =>
        tool === 'circle' ? centerRelations(id, metaOf(d.fromSnap).snap) : tool === 'rectangle' ? rectRelations(id, d.from, to, metaOf(d.fromSnap).snap, toSnap) : [],
      );
  };
  const color = view.paper ? '#1f5fd6' : '#ffd166';
  // 숫자를 치는 중이면 미리보기도 그 값으로
  const typedPoint = typed && multi ? typedNext(typed)?.p ?? null : null;
  const typedPreview = typed && !multi ? typedShape(typed)?.shape ?? null : null;
  const hoverPt = typedPoint ?? hover?.point ?? null;
  const labelAt = typedPoint ?? hover?.point ?? poly.at(-1) ?? drag?.from ?? null;

  return (
    <group matrixAutoUpdate={false} matrix={frame}>
      {/* 포인터를 받는 보이지 않는 평면 (스케치 평면 위) */}
      <mesh onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerLeave={() => setHover(null)} name="sketch-draw-plane">
        <planeGeometry args={[20000, 20000]} />
        <meshBasicMaterial transparent opacity={0} depthWrite={false} side={DoubleSide} />
      </mesh>
      {typedPreview ? <DrawPreview shape={typedPreview} color={color} /> : drag && <DrawPreview shape={shapeOf(drag, isPointSnap(hover))} color={color} />}
      {multi && poly.length > 0 && tool !== 'arc' && <PolylinePreview points={hoverPt ? [...poly, hoverPt] : poly} count={poly.length} color={color} />}
      {tool === 'arc' && poly.length > 0 && <ArcPreview points={poly} hover={hoverPt} color={color} />}
      {hover && !typed && <SnapFeedback snap={hover} px={view.mmPerPx} paper={view.paper} from={drag ? null : poly.at(-1) ?? null} showSegment={multi && tool !== 'arc'} />}
      {typed && labelAt && (
        <Html position={[labelAt[0], labelAt[1], 0]} style={{ pointerEvents: 'none' }}>
          <div className={`typed-input${view.paper ? ' on-paper' : ''}`} data-testid="typed-input">
            {typed.fields.map((f, i) => (
              <span key={i} className={i === typed.active ? 'active' : ''}>
                {typedFields()?.[i] ?? ''} <b>{f || ' '}</b>
                {i === 1 && multi ? '°' : 'mm'}
              </span>
            ))}
            <small>Enter 확정 · Tab 다음 칸 · Esc 취소</small>
          </div>
        </Html>
      )}
    </group>
  );
}

/** 화면에서 이만큼(픽셀) 가까우면 점·정렬에 붙는다 */
const SNAP_PX = 10;

/**
 * 스냅 표시: 붙은 점 모양(끝점 □, 중심 ○, 중간점 △, 사분점 ◇, 원점 ●) + 이름, 정렬 안내선(파란 점선),
 * 커서 좌표, 선을 그리는 중이면 길이·각도
 */
function SnapFeedback({ snap, px, paper, from, showSegment }: { snap: SnapResult; px: number; paper: boolean; from: Point2 | null; showSegment: boolean }) {
  const [x, y] = snap.point;
  const s = px * 6;
  const z = 0.03;
  const accent = paper ? '#e0662b' : '#ffb04a';
  const guide = paper ? '#2f7de1' : '#7fb6ff';
  let glyph: [number, number, number][] | null = null;
  if (snap.kind === 'endpoint') glyph = [[x - s, y - s, z], [x + s, y - s, z], [x + s, y + s, z], [x - s, y + s, z], [x - s, y - s, z]];
  else if (snap.kind === 'midpoint') glyph = [[x - s, y - s * 0.7, z], [x + s, y - s * 0.7, z], [x, y + s, z], [x - s, y - s * 0.7, z]];
  else if (snap.kind === 'quadrant') glyph = [[x, y - s, z], [x + s, y, z], [x, y + s, z], [x - s, y, z], [x, y - s, z]];
  else if (snap.kind === 'center' || snap.kind === 'origin')
    glyph = Array.from({ length: 17 }, (_, i) => [x + s * Math.cos((i / 16) * Math.PI * 2), y + s * Math.sin((i / 16) * Math.PI * 2), z] as [number, number, number]);
  const name = SNAP_LABEL[snap.kind];
  const extras: string[] = [];
  for (const g of snap.guides) {
    if (g.dir === 'h') extras.push('수평 정렬');
    if (g.dir === 'v') extras.push('수직 정렬');
  }
  let segment = '';
  if (showSegment && from) {
    const len = Math.hypot(x - from[0], y - from[1]);
    const ang = ((Math.atan2(y - from[1], x - from[0]) * 180) / Math.PI + 360) % 360;
    if (len > 0) segment = `${formatMm(len)} mm · ${formatMm(Math.round(ang * 10) / 10)}°`;
  }
  return (
    <group raycast={() => null}>
      {snap.guides.map((g, i) => (
        <DreiLine
          key={i}
          points={g.dir === 'angle' ? [[g.from[0], g.from[1], z], [x + (x - g.from[0]) * 0.6, y + (y - g.from[1]) * 0.6, z]] : [[g.from[0], g.from[1], z], [x, y, z]]}
          color={guide}
          lineWidth={1}
          dashed
          dashSize={px * 6}
          gapSize={px * 4}
          depthTest={false}
        />
      ))}
      {glyph && <DreiLine points={glyph} color={accent} lineWidth={2} depthTest={false} />}
      <Html position={[x, y, 0]} style={{ pointerEvents: 'none' }}>
        <div className={`snap-hud${paper ? ' on-paper' : ''}`} data-testid="snap-hud" data-snap={snap.kind}>
          {(name || extras.length > 0) && <b>{[name, ...extras].filter(Boolean).join(' · ')}</b>}
          <span>
            {formatMm(x)}, {formatMm(y)}
          </span>
          {segment && <span data-testid="segment-hud">{segment}</span>}
        </div>
      </Html>
    </group>
  );
}

function DrawPreview({ shape, color }: { shape: Exclude<DrawnShape, { type: 'polygon' | 'path' | 'arc' }>; color: string }) {
  const { geometry, label, anchor } = useMemo(() => {
    const pts: number[] = [];
    let label: string;
    let anchor: [number, number, number];
    if (shape.type === 'rectangle' || shape.type === 'ellipse') {
      const [x0, y0] = shape.from;
      const [x1, y1] = shape.to;
      if (shape.type === 'rectangle') for (const [x, y] of [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] as const) pts.push(x, y, 0.03);
      else
        for (let i = 0; i < 64; i++) {
          const a = (i / 64) * Math.PI * 2;
          pts.push((x0 + x1) / 2 + (Math.abs(x1 - x0) / 2) * Math.cos(a), (y0 + y1) / 2 + (Math.abs(y1 - y0) / 2) * Math.sin(a), 0.03);
        }
      label = `${shape.type === 'ellipse' ? '타원 ' : ''}${formatMm(Math.abs(x1 - x0))} × ${formatMm(Math.abs(y1 - y0))} mm`;
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
        <lineBasicMaterial color={color} depthTest={false} />
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
function ArcPreview({ points, hover, color }: { points: Point2[]; hover: Point2 | null; color: string }) {
  const line = useMemo(() => {
    let pts: Point2[] = hover ? [...points, hover] : points;
    if (points.length === 2 && hover) {
      const arc = bulgeThrough(points[0]!, points[1]!, hover);
      if (arc) pts = sampleSegments([bulgeArc(points[0]!, points[1]!, arc.bulge)], false);
    }
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(pts.flatMap(([x, y]) => [x, y, 0.03]), 3));
    const l = new Line(g, new LineBasicMaterial({ color, depthTest: false }));
    l.raycast = () => {};
    return l;
  }, [points, hover, color]);
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
function PolylinePreview({ points, count, color }: { points: Point2[]; count: number; color: string }) {
  // <line> 은 JSX 에서 SVG 요소와 이름이 겹치므로 Three.js Line 객체를 직접 만든다
  const line = useMemo(() => {
    const g = new BufferGeometry();
    g.setAttribute('position', new Float32BufferAttribute(points.flatMap(([x, y]) => [x, y, 0.03]), 3));
    const l = new Line(g, new LineBasicMaterial({ color, depthTest: false }));
    l.raycast = () => {};
    return l;
  }, [points, color]);
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
