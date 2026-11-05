import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Plane, Raycaster, Vector2, Vector3 } from 'three';
import type { OrbitControls as OrbitControlsImpl } from 'three-stdlib';
import { useSceneStore } from '../../cad/sceneStore';
import { centroid, extrudeFaces, faceNormal, insetFaces, transformVerts, type V3 } from '../../cad/polymesh';
import { formatMm } from '../../cad/units';
import { useModelingStore, type ModelingPreview } from '../../features/modeling/modelingStore';
import { activeObject, selectedFaceIds } from '../../features/modeling/modelingOps';
import {
  AXIS_VEC, dirToWorld, grabDelta, localMatrix, modalLabel, movedTransform, parseTyped, screenAngle, screenScale, toWorld, worldMatrix,
} from '../../features/modeling/modalMath';

const round = (v: number, step: number) => Math.round(v / step) * step;

/**
 * 모달 조작 계산기 (캔버스 안): 마우스 위치·축 잠금·입력값이 바뀔 때마다 미리보기와 확정할 명령을 만든다.
 * 실제 확정·취소는 키보드(ModelingKeys)와 클릭(ModelingPicker)이 store 의 preview.command 로 한다.
 */
export function ModalController() {
  const seq = useModelingStore((s) => s.modal?.seq ?? 0);
  const camera = useThree((s) => s.camera);
  const size = useThree((s) => s.size);
  const controls = useThree((s) => s.controls) as OrbitControlsImpl | null;

  useEffect(() => {
    const st0 = useModelingStore.getState();
    const modal0 = st0.modal;
    const obj = activeObject();
    if (!modal0 || !obj) return;
    if (controls) controls.enabled = false;
    const t = obj.transform;
    const editing = st0.mode === 'edit' && obj.kind === 'polymesh';
    const mesh = obj.kind === 'polymesh' ? obj.polymesh : null;
    const sel = st0.selVerts;
    const faces = editing && mesh ? selectedFaceIds(mesh) : [];

    const pivot: V3 = editing && mesh ? toWorld(centroid(mesh, sel), t) : [...t.position];
    // 화면 → 월드: 피벗을 지나고 화면과 나란한 평면 위의 점
    const camDir = camera.getWorldDirection(new Vector3());
    const plane = new Plane().setFromNormalAndCoplanarPoint(camDir, new Vector3(...pivot));
    const ray = new Raycaster();
    const worldAt = ([x, y]: [number, number]): Vector3 => {
      ray.setFromCamera(new Vector2((x / size.width) * 2 - 1, -(y / size.height) * 2 + 1), camera);
      return ray.ray.intersectPlane(plane, new Vector3()) ?? new Vector3(...pivot);
    };
    const screenOf = (p: V3): [number, number] => {
      const v = new Vector3(...p).project(camera);
      return [((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height];
    };
    const start = modal0.start;
    const p0 = worldAt(start);
    const pivotScreen = screenOf(pivot);
    const toViewer = camDir.clone().negate();

    // 돌출 방향 = 고른 면 법선 평균 (로컬)
    let nLocal: V3 = [0, 0, 1];
    if (faces.length && mesh) {
      const n = faces.reduce<V3>((a, fi) => {
        const f = faceNormal(mesh, mesh.faces[fi]!);
        return [a[0] + f[0], a[1] + f[1], a[2] + f[2]];
      }, [0, 0, 0]);
      const l = Math.hypot(...n) || 1;
      nLocal = [n[0] / l, n[1] / l, n[2] / l];
    }
    const nWorld = dirToWorld(nLocal, t);

    const update = () => {
      const { modal, mouse } = useModelingStore.getState();
      if (!modal || modal.seq !== modal0.seq) return;
      const typed = parseTyped(modal.typed);
      const shown = modal.typed ? modal.typed : null;
      const d = worldAt(mouse).sub(p0);
      const mouseDelta: V3 = [d.x, d.y, d.z];
      let preview: ModelingPreview;
      if (modal.kind === 'extrude' && mesh) {
        const dist = typed ?? round(mouseDelta[0] * nWorld[0] + mouseDelta[1] * nWorld[1] + mouseDelta[2] * nWorld[2], 0.01);
        const offset: V3 = [nLocal[0] * dist, nLocal[1] * dist, nLocal[2] * dist].map((v) => round(v, 1e-6)) as V3;
        const r = extrudeFaces(mesh, faces, offset);
        preview = {
          objectId: obj.id, mesh: r.mesh, afterSel: r.sel, label: modalLabel('extrude', null, shown ?? `${formatMm(dist)}mm`),
          command: { type: 'mesh_edit', target: obj.id, edit: { op: 'extrude', faces, offset } },
        };
      } else if (modal.kind === 'inset' && mesh) {
        const th = Math.max(0.01, typed ?? round(Math.hypot(...mouseDelta), 0.01));
        const r = insetFaces(mesh, faces, th);
        preview = {
          objectId: obj.id, mesh: r.mesh, afterSel: r.sel, label: modalLabel('inset', null, shown ?? `${formatMm(th)}mm`),
          command: { type: 'mesh_edit', target: obj.id, edit: { op: 'inset', faces, thickness: th } },
        };
      } else {
        let world;
        let value: string;
        if (modal.kind === 'grab') {
          const delta = grabDelta(mouseDelta, modal.axis, typed).map((v) => round(v, 0.01)) as V3;
          world = worldMatrix({ kind: 'grab', delta }, pivot);
          value = modal.axis ? `${formatMm(delta[0] + delta[1] + delta[2])}mm` : `(${delta.map((v) => formatMm(v)).join(', ')})`;
        } else if (modal.kind === 'rotate') {
          const axis = modal.axis ? AXIS_VEC[modal.axis] : ([toViewer.x, toViewer.y, toViewer.z] as V3);
          const facing = axis[0] * toViewer.x + axis[1] * toViewer.y + axis[2] * toViewer.z >= 0 ? 1 : -1;
          const deg = typed ?? round(screenAngle(pivotScreen, start, mouse) * facing, 0.1);
          world = worldMatrix({ kind: 'rotate', axis, degrees: deg }, pivot);
          value = `${formatMm(deg)}°`;
        } else {
          const f = typed ?? round(screenScale(pivotScreen, start, mouse), 0.001);
          world = worldMatrix({ kind: 'scale', factor: f, axis: modal.axis ? AXIS_VEC[modal.axis] : null }, pivot);
          value = `×${formatMm(f)}`;
        }
        const label = modalLabel(modal.kind, modal.axis, shown ?? value);
        if (!editing && modal.kind !== 'scale') {
          const tr = movedTransform(world, t);
          preview = { objectId: obj.id, transform: tr, label, command: { type: 'set_transform', target: obj.id, position: tr.position, rotation: tr.rotation } };
        } else if (mesh) {
          const verts = editing ? sel : mesh.verts.map((_, i) => i);
          const matrix = localMatrix(world, t);
          preview = {
            objectId: obj.id, mesh: transformVerts(mesh, verts, matrix), afterSel: editing ? sel : undefined, label,
            command: { type: 'mesh_edit', target: obj.id, edit: { op: 'transform', verts, matrix } },
          };
        } else return;
      }
      useModelingStore.getState().setPreview(preview);
    };
    update();
    const unsub = useModelingStore.subscribe((s, prev) => {
      if (s.mouse !== prev.mouse || s.modal !== prev.modal) update();
    });
    return () => {
      unsub();
      if (controls) controls.enabled = true;
    };
    // 새 모달(seq)마다 한 번 준비한다. 모델·카메라는 모달 동안 바뀌지 않는다
  }, [seq]);

  return null;
}

/** 모달 확정: 미리보기 명령을 보내고 선택을 이어 간다 */
export function confirmModal() {
  const st = useModelingStore.getState();
  const p = st.preview;
  st.setModal(null);
  if (!p?.command) return;
  const r = useSceneStore.getState().submitNow(p.command);
  if (r.status === 'applied' && p.afterSel) st.setSel(p.afterSel);
}

export function cancelModal() {
  useModelingStore.getState().setModal(null);
}
