import { useEffect } from 'react';
import { useThree } from '@react-three/fiber';
import { Box3, Mesh, Vector3 } from 'three';
import { useSceneStore } from '../../cad/sceneStore';


/**
 * 개발 모드 전용: 월드 좌표(mm) → 페이지 픽셀 좌표 변환을 노출한다.
 * E2E 테스트가 기즈모 핸들 위치를 계산하는 데 사용한다. 프로덕션 빌드에는 포함되지 않는다.
 */
export function DevProbe() {
  const camera = useThree((s) => s.camera);
  const gl = useThree((s) => s.gl);
  const scene = useThree((s) => s.scene);

  useEffect(() => {
    window.__AI3D_DEV__ = {
      project: (x, y, z) => {
        const v = new Vector3(x, y, z).project(camera);
        const r = gl.domElement.getBoundingClientRect();
        return { x: r.left + ((v.x + 1) / 2) * r.width, y: r.top + ((1 - v.y) / 2) * r.height };
      },
      /** 카메라가 바라보는 방향(단위 벡터, 소수 셋째 자리) — 표준 보기 검사용 */
      cameraDir: () => camera.getWorldDirection(new Vector3()).toArray().map((v) => Math.round(v * 1000) / 1000 + 0),
      meshSources: () => {
        const out: Record<string, { source: string; min: number[]; max: number[]; vertices: number }> = {};
        scene.updateMatrixWorld(true);
        scene.traverse((o) => {
          if (!o.userData.cadObject) return;
          const mesh = o.children.find((c): c is Mesh => c instanceof Mesh && !!c.userData.source);
          if (!mesh) return;
          const box = new Box3().setFromObject(mesh);
          out[o.name] = {
            source: mesh.userData.source as string,
            min: box.min.toArray().map((v) => Math.round(v * 1000) / 1000),
            max: box.max.toArray().map((v) => Math.round(v * 1000) / 1000),
            vertices: mesh.geometry.getAttribute('position').count,
          };
        });
        return out;
      },
      scene: () => {
        const h = useSceneStore.getState().history;
        return {
          revision: h.present.revision,
          past: h.past.length,
          future: h.future.length,
          commandId: h.present.commandId ?? null,
          baseRevision: h.past.at(-1)?.revision ?? null,
          command: h.present.command,
          objects: h.present.model.objects.map((o) => ({ id: o.id, position: [...o.transform.position], rotation: [...o.transform.rotation] })),
          sketches: h.present.model.sketches.map((k) => ({ id: k.id, plane: k.plane, entities: k.entities.map((e) => ({ id: e.id, type: e.type, ...('center' in e ? { center: [...e.center] } : {}) })) })),
          mates: h.present.model.mates ?? [],
        };
      },
      submit: (envelope) => useSceneStore.getState().submit(envelope),
      dispatch: (command) => useSceneStore.getState().dispatch(command),
    };
    return () => {
      delete window.__AI3D_DEV__;
    };
  }, [camera, gl, scene]);

  return null;
}
