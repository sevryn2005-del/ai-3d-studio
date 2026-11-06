import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Raycaster, Vector2, Vector3 } from 'three';
import { useSceneStore } from '../../cad/sceneStore';
import type { V3 } from '../../cad/polymesh';
import { useModelingStore } from '../../features/modeling/modelingStore';
import { editTarget, selectedFaceIds } from '../../features/modeling/modelingOps';
import { dirToLocal } from '../../features/modeling/modalMath';
import { toMatrix } from '../../cad/transformMath';
import { notify } from '../../features/projects/projectActions';

/**
 * 나이프 (편집 모드 K): 화면에 선을 끌어 그으면, 그 선을 지나 시선 방향으로 뻗은 평면으로 면을 자른다
 * (고른 면이 있으면 그 면만, 없으면 전부). 놓으면 mesh_edit bisect 하나 (실행 취소 1번). Esc·오른쪽 클릭 = 취소.
 */
export function KnifeController() {
  const active = useModelingStore((s) => !!s.knife);
  const gl = useThree((s) => s.gl);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    if (!active) return;
    const el = gl.domElement;
    const pos = (e: PointerEvent): [number, number] => {
      const r = el.getBoundingClientRect();
      return [e.clientX - r.left, e.clientY - r.top];
    };
    const ray = (p: [number, number]) => {
      const rc = new Raycaster();
      rc.setFromCamera(new Vector2((p[0] / el.clientWidth) * 2 - 1, -(p[1] / el.clientHeight) * 2 + 1), camera);
      return rc.ray;
    };
    const st = () => useModelingStore.getState();
    const onDown = (e: PointerEvent) => {
      e.stopImmediatePropagation();
      if (e.button === 2) return st().setKnife(null);
      if (e.button !== 0) return;
      el.setPointerCapture(e.pointerId);
      st().setKnife({ a: pos(e), b: pos(e) });
    };
    const onMove = (e: PointerEvent) => {
      const k = st().knife;
      if (k?.a) st().setKnife({ a: k.a, b: pos(e) });
    };
    const onUp = (e: PointerEvent) => {
      const k = st().knife;
      if (!k?.a || e.button !== 0) return;
      e.stopImmediatePropagation();
      const b = pos(e);
      st().setKnife(null);
      if (Math.hypot(b[0] - k.a[0], b[1] - k.a[1]) < 4) return;
      const t = editTarget();
      if (!t) return;
      // 두 화면 점의 시선 두 줄을 품은 평면 (원근·직교 모두): 점 셋으로
      const ra = ray(k.a);
      const rb = ray(b);
      const p1 = ra.at(10, new Vector3());
      const p2 = rb.at(10, new Vector3());
      const p3 = ra.at(1000, new Vector3());
      const nW = p2.clone().sub(p1).cross(p3.clone().sub(p1));
      if (nW.lengthSq() < 1e-12) return;
      const inv = toMatrix(t.transform).invert();
      const point = p1.clone().applyMatrix4(inv).toArray().map((v) => Math.round(v * 1e6) / 1e6) as V3;
      const n = dirToLocal(nW.normalize().toArray() as V3, t.transform).map((v) => Math.round(v * 1e9) / 1e9) as V3;
      const faces = selectedFaceIds(t.polymesh);
      const before = t.polymesh.faces.length;
      const r = useSceneStore.getState().submitNow({ type: 'mesh_edit', target: t.id, edit: { op: 'bisect', faces, point, normal: n } });
      const after = editTarget()?.polymesh.faces.length ?? before;
      if (r.status === 'applied' && after === before) notify('나이프: 선이 면을 가로지르지 않았습니다 (면 위로 선을 그어 보세요)');
    };
    el.addEventListener('pointerdown', onDown, { capture: true });
    el.addEventListener('pointermove', onMove);
    el.addEventListener('pointerup', onUp, { capture: true });
    el.style.cursor = 'crosshair';
    return () => {
      el.removeEventListener('pointerdown', onDown, { capture: true });
      el.removeEventListener('pointermove', onMove);
      el.removeEventListener('pointerup', onUp, { capture: true });
      el.style.cursor = '';
    };
  }, [active, gl, camera]);
  return null;
}

/** 화면 위 나이프 선 (SVG) */
export function KnifeOverlay() {
  const k = useModelingStore((s) => s.knife);
  if (!k) return null;
  return (
    <svg className="knife-overlay" data-testid="knife-overlay">
      {k.a && k.b && <line x1={k.a[0]} y1={k.a[1]} x2={k.b[0]} y2={k.b[1]} stroke="#ffd166" strokeWidth={2} strokeDasharray="6 4" />}
      {!k.a && <text x={12} y={24} fill="#ffd166" fontSize={12}>나이프: 자를 선을 끌어 그으세요 (Esc 취소)</text>}
    </svg>
  );
}
