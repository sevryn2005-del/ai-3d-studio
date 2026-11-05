import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Mesh, Raycaster, Vector2, Vector3, type Object3D } from 'three';
import { useSceneStore } from '../../cad/sceneStore';
import { edges } from '../../cad/polymesh';
import { useModelingStore } from '../../features/modeling/modelingStore';
import { editTarget } from '../../features/modeling/modelingOps';
import { cancelModal, confirmModal } from './ModalController';

const PICK_PX = 14;

/** 점 p 에서 선분 ab 까지 화면 거리 */
function segDist(p: [number, number], a: [number, number], b: [number, number]): number {
  const [dx, dy] = [b[0] - a[0], b[1] - a[1]];
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / l2)) : 0;
  return Math.hypot(p[0] - a[0] - t * dx, p[1] - a[1] - t * dy);
}

function cadObjectOf(o: Object3D | null): string | null {
  for (let n: Object3D | null = o; n; n = n.parent) if (typeof n.userData.cadObject === 'string') return n.userData.cadObject;
  return null;
}

/**
 * 모델링 모드 클릭 (블렌더 흐름, 왼쪽 클릭 = 선택):
 * - 모달 중: 왼쪽 = 확정, 오른쪽 = 취소
 * - 오브젝트 모드: 객체 고르기 (빈 곳 = 해제)
 * - 편집 모드: 점·선·면 고르기 (Shift = 더하기/빼기), 가려진 점은 건너뛴다
 */
export function ModelingPicker() {
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    const el = gl.domElement;
    let down: [number, number] | null = null;
    const pos = (e: PointerEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const ndc = ([x, y]: [number, number]) => new Vector2((x / el.clientWidth) * 2 - 1, -(y / el.clientHeight) * 2 + 1);

    const onDown = (e: PointerEvent) => {
      if (useModelingStore.getState().mode === 'sculpt') return; // 스컬프트는 SculptController
      if (useModelingStore.getState().modal) {
        if (e.button === 0) confirmModal();
        else if (e.button === 2) cancelModal();
        e.stopPropagation();
        down = null;
        return;
      }
      down = e.button === 0 ? pos(e) : null;
    };
    const onUp = (e: PointerEvent) => {
      if (!down || e.button !== 0) return;
      const p = pos(e);
      const moved = Math.hypot(p[0] - down[0], p[1] - down[1]);
      down = null;
      if (moved > 4) return; // 드래그 = 화면 돌리기
      const st = useModelingStore.getState();
      const ray = new Raycaster();
      ray.setFromCamera(ndc(p), camera);
      if (st.mode === 'object') {
        const hit = ray.intersectObjects(scene.children, true).find((h) => cadObjectOf(h.object));
        useSceneStore.getState().select(hit ? cadObjectOf(hit.object) : null);
        return;
      }
      const t = editTarget();
      const meshObj = scene.getObjectByName('polymesh-edit') as Mesh | undefined;
      if (!t || !meshObj) return;
      const m = t.polymesh;
      meshObj.updateWorldMatrix(true, false);
      const world = m.verts.map((v) => new Vector3(...v).applyMatrix4(meshObj.matrixWorld));
      const screen = world.map((w): [number, number] => {
        const s = w.clone().project(camera);
        return [((s.x + 1) / 2) * el.clientWidth, ((1 - s.y) / 2) * el.clientHeight];
      });
      const surfaceHit = ray.intersectObject(meshObj, false)[0];
      const visible = (i: number) => {
        // 카메라 → 점 사이에 메시 면이 있으면 가려진 점
        const r = new Raycaster();
        const dir = world[i]!.clone().sub(camera.position);
        const dist = dir.length();
        r.set(camera.position, dir.normalize());
        const h = r.intersectObject(meshObj, false)[0];
        return !h || h.distance > dist - Math.max(1e-3, dist * 1e-4);
      };
      let picked: number[] = [];
      if (st.selectMode === 'vert') {
        const cands = screen
          .map((s, i) => ({ i, d: Math.hypot(s[0] - p[0], s[1] - p[1]) }))
          .filter((c) => c.d <= PICK_PX)
          .sort((a, b) => a.d - b.d);
        const c = cands.find((c) => visible(c.i)) ?? null;
        if (c) picked = [c.i];
      } else if (st.selectMode === 'edge') {
        const cands = edges(m)
          .map(([a, b]) => ({ a, b, d: segDist(p, screen[a]!, screen[b]!) }))
          .filter((c) => c.d <= PICK_PX)
          .sort((x, y) => x.d - y.d);
        const c = cands.find((c) => visible(c.a) || visible(c.b)) ?? null;
        if (c) picked = [c.a, c.b];
      } else if (surfaceHit && surfaceHit.faceIndex != null) {
        const fi = (meshObj.geometry.userData.triFace as number[])[surfaceHit.faceIndex];
        if (fi != null) picked = [...m.faces[fi]!];
      }
      if (!e.shiftKey) return st.setSel(picked);
      if (!picked.length) return;
      const cur = new Set(st.selVerts);
      const all = picked.every((v) => cur.has(v));
      st.setSel(all ? st.selVerts.filter((v) => !picked.includes(v)) : [...st.selVerts, ...picked.filter((v) => !cur.has(v))]);
    };
    const onContext = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointerup', onUp);
    el.addEventListener('contextmenu', onContext);
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointerup', onUp);
      el.removeEventListener('contextmenu', onContext);
    };
  }, [gl, camera, scene]);

  return null;
}
