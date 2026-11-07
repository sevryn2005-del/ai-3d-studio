import { useEffect, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { Line } from '@react-three/drei';
import { Matrix3, Mesh, OrthographicCamera, PerspectiveCamera, Plane, Raycaster, Vector2, Vector3 } from 'three';
import { useSceneStore } from '../../cad/sceneStore';
import type { PolyMesh, V3 } from '../../cad/polymesh';
import { BRUSH_LABEL, applyDab, grabStroke, paintMask, sculptContext, strokeEdit, type SculptContext } from '../../cad/sculpt';
import { collapseNear, extendValues, refineNear, remapValues } from '../../cad/dyntopo';
import { MAX_POLY_FACES, MAX_POLY_VERTS } from '../../cad/commandTypes';
import { useModelingStore } from '../../features/modeling/modelingStore';
import { editTarget } from '../../features/modeling/modelingOps';

interface Hit {
  world: Vector3;
  normalWorld: Vector3;
  local: V3;
  normalLocal: V3;
  /** 브러시 반지름 (mm) — 화면 픽셀 반지름을 이 깊이에서 mm 로 */
  radius: number;
}

/**
 * 스컬프트 모드 (블렌더 흐름): 왼쪽 드래그 = 브러시 한 획, Shift = 매끈하게, Ctrl = 반대로.
 * 획 동안은 미리보기만 바뀌고, 뗄 때 바뀐 점이 mesh_edit set_verts 명령 하나가 된다 (실행 취소 1번).
 * 다이나믹 토폴로지(Ctrl+D)가 켜져 있으면 찍기 전에 붓 아래 긴 선을 쪼개고(cad/dyntopo.ts), 뗄 때 mesh_edit replace 하나.
 * 가운데 드래그 = 화면 돌리기 (Alt+왼쪽도) — 브러시는 왼쪽 버튼만.
 */
export function SculptController() {
  const mode = useModelingStore((s) => s.mode);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);
  const [cursor, setCursor] = useState<Hit | null>(null);
  const stroke = useRef<{
    base: PolyMesh;
    current: PolyMesh;
    ctx: SculptContext;
    last: V3;
    start: Hit;
    plane: Plane;
    startWorld: Vector3;
  } | null>(null);

  useEffect(() => {
    if (mode !== 'sculpt') {
      setCursor(null);
      return;
    }
    const el = gl.domElement;
    const ray = new Raycaster();
    const ndcOf = (e: PointerEvent) => {
      const r = el.getBoundingClientRect();
      return new Vector2(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    };
    const target = () => editTarget();
    const meshObj = () => {
      const t = target();
      return t ? (scene.getObjectByName(`polymesh-${t.id}`) as Mesh | undefined) : undefined;
    };
    const mmPerPx = (at: Vector3) => {
      if (camera instanceof OrthographicCamera) return (camera.top - camera.bottom) / camera.zoom / el.clientHeight;
      const fov = ((camera as PerspectiveCamera).fov * Math.PI) / 180;
      return (camera.position.distanceTo(at) * 2 * Math.tan(fov / 2)) / el.clientHeight;
    };
    const hitAt = (e: PointerEvent): Hit | null => {
      const m = meshObj();
      if (!m) return null;
      ray.setFromCamera(ndcOf(e), camera);
      const h = ray.intersectObject(m, false)[0];
      if (!h || !h.face) return null;
      m.updateWorldMatrix(true, false);
      const local = m.worldToLocal(h.point.clone());
      const nLocal = h.face.normal.clone().normalize();
      const nWorld = nLocal.clone().applyMatrix3(new Matrix3().getNormalMatrix(m.matrixWorld)).normalize();
      const radius = useModelingStore.getState().sculpt.radiusPx * mmPerPx(h.point);
      return { world: h.point.clone(), normalWorld: nWorld, local: local.toArray() as V3, normalLocal: nLocal.toArray() as V3, radius };
    };

    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 || e.altKey) return;
      const t = target();
      const h = hitAt(e);
      if (!t || !h) return;
      e.stopPropagation();
      el.setPointerCapture(e.pointerId);
      const base = t.polymesh;
      const camDir = camera.getWorldDirection(new Vector3());
      stroke.current = {
        base,
        current: base,
        ctx: sculptContext(base),
        last: h.local,
        start: h,
        plane: new Plane().setFromNormalAndCoplanarPoint(camDir, h.world),
        startWorld: h.world.clone(),
      };
      dab(e, h, true);
    };
    const dab = (e: PointerEvent, h: Hit, first = false) => {
      const s = stroke.current;
      const t = target();
      if (!s || !t) return;
      const set = useModelingStore.getState().sculpt;
      const brush = e.shiftKey ? 'smooth' : set.brush;
      const mask = currentMask(t.id, s.current.verts.length);
      if (brush === 'mask') {
        // 마스크: 모양은 그대로, 점마다 보호 값만 (Ctrl = 지우기)
        const moved = Math.hypot(h.local[0] - s.last[0], h.local[1] - s.last[1], h.local[2] - s.last[2]);
        if (!first && moved < h.radius * 0.15) return;
        s.last = h.local;
        useModelingStore.getState().setMask({ objectId: t.id, values: paintMask(s.base, mask, h.local, h.radius, set.strength, e.ctrlKey || e.metaKey, set.symmetryX) });
        return;
      }
      if (brush === 'grab') {
        // 잡아끌기: 시작점을 화면과 나란한 평면 위에서 끈다
        ray.setFromCamera(ndcOf(e), camera);
        const p = ray.ray.intersectPlane(s.plane, new Vector3());
        if (!p) return;
        const m = meshObj()!;
        const a = m.worldToLocal(s.startWorld.clone());
        const b = m.worldToLocal(p.clone());
        const delta: V3 = [b.x - a.x, b.y - a.y, b.z - a.z];
        s.current = grabStroke(s.base, s.start.local, s.start.radius, delta, set.strength, set.symmetryX, mask);
      } else {
        // 획 간격: 반지름의 15% 마다 한 번 찍는다 (마우스 이벤트 속도와 무관하게 고르게)
        const moved = Math.hypot(h.local[0] - s.last[0], h.local[1] - s.last[1], h.local[2] - s.last[2]);
        if (!first && moved < h.radius * 0.15) return;
        s.last = h.local;
        if (set.dyntopo && s.current.verts.length < MAX_POLY_VERTS && s.current.faces.length < MAX_POLY_FACES - 64) {
          // 붓 아래(대칭이면 반대쪽도) 긴 선 쪼개기 → 이웃·법선을 다시 구하고 마스크도 늘린다
          const centers: V3[] = [h.local, ...(set.symmetryX && Math.abs(h.local[0]) > h.radius * 0.05 ? [[-h.local[0], h.local[1], h.local[2]] as V3] : [])];
          let refined = false;
          for (const c of centers) {
            const r = refineNear(s.current, c, h.radius, h.radius * set.detail, MAX_POLY_VERTS, 2);
            if (!r) continue;
            refined = true;
            const prevMask = currentMask(t.id, s.current.verts.length);
            s.current = r.mesh;
            if (prevMask) useModelingStore.getState().setMask({ objectId: t.id, values: extendValues(prevMask, r.parents) });
          }
          // 너무 짧아진 선은 합친다 (최대 길이의 40%) — 점이 끝없이 늘지 않게
          for (const c of centers) {
            const r = collapseNear(s.current, c, h.radius, h.radius * set.detail * 0.4, 1);
            if (!r) continue;
            refined = true;
            const prevMask = currentMask(t.id, s.current.verts.length);
            s.current = r.mesh;
            if (prevMask) useModelingStore.getState().setMask({ objectId: t.id, values: remapValues(prevMask, r.remap, r.mesh.verts.length) });
          }
          if (refined) s.ctx = sculptContext(s.current);
        }
        s.current = applyDab(s.current, s.ctx, {
          brush,
          center: h.local,
          normal: h.normalLocal,
          radius: h.radius,
          strength: set.strength,
          invert: e.ctrlKey || e.metaKey,
          symmetryX: set.symmetryX,
          mask: currentMask(t.id, s.current.verts.length),
        });
      }
      useModelingStore.getState().setPreview({ objectId: t.id, mesh: s.current, label: `스컬프트: ${BRUSH_LABEL[brush]}`, command: null });
    };
    const onMove = (e: PointerEvent) => {
      const h = hitAt(e);
      setCursor(h ?? (stroke.current ? stroke.current.start : null));
      if (stroke.current) {
        if (h || useModelingStore.getState().sculpt.brush === 'grab') dab(e, h ?? stroke.current.start);
      }
    };
    const onUp = (e: PointerEvent) => {
      const s = stroke.current;
      if (!s || e.button !== 0) return;
      stroke.current = null;
      const t = target();
      useModelingStore.getState().setPreview(null);
      if (!t) return;
      if (s.current.faces !== s.base.faces) {
        // 점·면이 함께 바뀜 (다이나믹 토폴로지) → 메시 통째로 하나
        const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
        const mesh = { verts: s.current.verts.map((p) => [r6(p[0]), r6(p[1]), r6(p[2])] as V3), faces: s.current.faces };
        useSceneStore.getState().submitNow({ type: 'mesh_edit', target: t.id, edit: { op: 'replace', mesh } });
        return;
      }
      const edit = strokeEdit(s.base, s.current);
      if (edit) useSceneStore.getState().submitNow({ type: 'mesh_edit', target: t.id, edit: { op: 'set_verts', ...edit } });
    };
    const onLeave = () => {
      if (!stroke.current) setCursor(null);
    };
    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp);
    el.addEventListener('pointerleave', onLeave);
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('pointerleave', onLeave);
      stroke.current = null;
    };
  }, [mode, gl, camera, scene]);

  if (mode !== 'sculpt' || !cursor) return null;
  // 브러시 원: 표면에 붙은 원 (법선에 수직), 반지름 = 브러시 반지름
  const n = cursor.normalWorld;
  const u = new Vector3(1, 0, 0).cross(n).lengthSq() > 1e-6 ? new Vector3(1, 0, 0).cross(n).normalize() : new Vector3(0, 1, 0).cross(n).normalize();
  const v = n.clone().cross(u);
  const c = cursor.world.clone().addScaledVector(n, cursor.radius * 0.02);
  const pts = Array.from({ length: 49 }, (_, i) => {
    const a = (i / 48) * Math.PI * 2;
    return c.clone().addScaledVector(u, Math.cos(a) * cursor.radius).addScaledVector(v, Math.sin(a) * cursor.radius).toArray() as [number, number, number];
  });
  return <Line points={pts} color="#ffffff" lineWidth={1.5} transparent opacity={0.85} depthTest={false} raycast={() => null} name="sculpt-cursor" />;
}

/** 지금 객체의 마스크 (점 수가 다르면 = 메시가 바뀌었으면 없는 것으로) */
export function currentMask(objectId: string, n: number): number[] | null {
  const m = useModelingStore.getState().mask;
  return m && m.objectId === objectId && m.values.length === n ? m.values : null;
}
