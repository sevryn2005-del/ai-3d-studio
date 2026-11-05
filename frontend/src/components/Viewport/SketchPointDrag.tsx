import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import { executeCommand } from '../../cad/commandExecutor';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { sketchSnapPoints } from '../../cad/sketchSnap';
import type { Point2 } from '../../cad/commandTypes';
import { useActiveSketch } from '../../features/sketch/activeSketch';
import { useSketchDrag } from '../../features/sketch/sketchDrag';
import { drawStep, useSketchView } from '../../features/sketch/sketchSettings';
import { useEditorStore } from '../../features/selection/editorStore';

const PICK_PX = 10;

/**
 * 스케치 꼭짓점 끌기 (솔리드웍스처럼): 스케치를 고른 상태(그리기 도구 없음)에서 꼭짓점·중심·사각형 모서리를
 * 왼쪽 버튼으로 끌면 구속을 지키며 다시 풀린 모양이 따라온다. 놓으면 move_point 명령 하나 (실행 취소 1번).
 */
export function SketchPointDrag() {
  const active = useActiveSketch();
  const drawTool = useEditorStore((s) => s.drawTool);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const sketch = active?.sketch;
    if (!sketch || drawTool) return;
    const el = gl.domElement;
    const frame = active.frame;
    const inverse = frame.clone().invert();
    const normal = new Vector3(0, 0, 1).transformDirection(frame);
    const origin = new Vector3().setFromMatrixPosition(frame);
    const plane = new Plane().setFromNormalAndCoplanarPoint(normal, origin);
    const ray = new Raycaster();
    let drag: { ref: string; moved: boolean; last: Point2 | null } | null = null;

    const local = (e: PointerEvent): Point2 | null => {
      const r = el.getBoundingClientRect();
      ray.setFromCamera(new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1), camera);
      const hit = ray.ray.intersectPlane(plane, new Vector3());
      if (!hit) return null;
      const p = hit.applyMatrix4(inverse);
      return [p.x, p.y];
    };
    const nearest = (e: PointerEvent): string | null => {
      const cur = useSceneStore.getState().history.present.model.sketches.find((k) => k.id === sketch.id);
      if (!cur) return null;
      const r = el.getBoundingClientRect();
      let best: { ref: string; d: number } | null = null;
      for (const sp of sketchSnapPoints(cur)) {
        if (!sp.ref) continue;
        const s = new Vector3(sp.p[0], sp.p[1], 0).applyMatrix4(frame).project(camera);
        const x = ((s.x + 1) / 2) * r.width;
        const y = ((1 - s.y) / 2) * r.height;
        const d = Math.hypot(x - (e.clientX - r.left), y - (e.clientY - r.top));
        if (d <= PICK_PX && (!best || d < best.d)) best = { ref: sp.ref, d };
      }
      return best?.ref ?? null;
    };
    const snapStep = () => {
      const v = useSketchView.getState();
      return v.gridSnap ? drawStep(v) : 0.001;
    };
    const round = (p: Point2): Point2 => {
      const s = snapStep();
      return [Number((Math.round(p[0] / s) * s).toFixed(6)) + 0, Number((Math.round(p[1] / s) * s).toFixed(6)) + 0];
    };
    const stop = (e: Event) => {
      e.stopImmediatePropagation();
      e.preventDefault();
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0) return;
      const ref = nearest(e);
      if (!ref) return;
      stop(e);
      el.setPointerCapture(e.pointerId);
      drag = { ref, moved: false, last: null };
    };
    const onMove = (e: PointerEvent) => {
      if (!drag) {
        const h = nearest(e);
        if (h !== useSketchDrag.getState().hover) useSketchDrag.getState().set({ hover: h });
        el.style.cursor = h ? 'grab' : '';
        return;
      }
      stop(e);
      el.style.cursor = 'grabbing';
      const p = local(e);
      if (!p) return;
      const to = round(p);
      if (drag.last && to[0] === drag.last[0] && to[1] === drag.last[1]) return;
      const model = selectModel(useSceneStore.getState());
      const r = executeCommand(model, { type: 'move_point', sketch: sketch.id, point: drag.ref, to });
      // 구속 때문에 갈 수 없는 자리면 마지막으로 풀린 모양을 그대로 둔다
      if (r.ok) {
        drag.moved = true;
        drag.last = to;
        useSketchDrag.getState().set({ preview: r.model.sketches.find((k) => k.id === sketch.id) ?? null });
      }
    };
    const onUp = (e: PointerEvent) => {
      if (!drag) return;
      stop(e);
      const d = drag;
      drag = null;
      el.style.cursor = '';
      useSketchDrag.getState().set({ preview: null });
      if (d.moved && d.last) useSceneStore.getState().submitNow({ type: 'move_point', sketch: sketch.id, point: d.ref, to: d.last });
      // 끌기를 끝낸 클릭이 객체 선택으로 이어지지 않게
      const swallow = (ev: Event) => stop(ev);
      el.addEventListener('click', swallow, { capture: true, once: true });
      setTimeout(() => el.removeEventListener('click', swallow, { capture: true }), 0);
    };
    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointermove', onMove, { capture: true });
    el.addEventListener('pointerup', onUp, { capture: true });
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove, { capture: true });
      el.removeEventListener('pointerup', onUp, { capture: true });
      el.style.cursor = '';
      useSketchDrag.getState().set({ preview: null, hover: null });
    };
  }, [active, drawTool, gl, camera]);

  return null;
}
