/**
 * 면·모서리 고르기 오버레이 (형식 v12). 엔진 위상(B-rep 면·모서리)을 화면에 겹쳐 그리고,
 * 포인터에 가까운 모서리(화면 8px 이내)를 먼저, 아니면 포인터 아래 면을 강조한다. 클릭 = 고르기(다시 클릭 = 빼기).
 * 고르는 동안 객체 클릭(선택)은 막는다 (CadObjectMesh).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { useThree } from '@react-three/fiber';
import { BufferAttribute, BufferGeometry, Line, LineBasicMaterial, Matrix4, Mesh, MeshBasicMaterial, Raycaster, Vector2, Vector3 } from 'three';
import { selectModel, useSceneStore } from '../../cad/sceneStore';
import { objectWorldMatrix } from '../../cad/sketchPlane';
import { getActiveEngine, useActiveEngineId } from '../../features/engine/engines';
import type { Topology } from '../../features/engine/types';
import { usePickStore, type PickedEntity, type PickRequest } from '../../features/selection/pick';

const EDGE_PX = 8;
const COLORS = { edge: '#8b949e', hover: '#ffb703', picked: '#4cc9f0' };

export function PickOverlay() {
  const request = usePickStore((s) => s.request);
  return request ? <PickScene request={request} /> : null;
}

type Loaded = { objectId: string; topo: Topology };

function PickScene({ request }: { request: PickRequest }) {
  const model = useSceneStore(selectModel);
  const engineId = useActiveEngineId();
  const [loaded, setLoaded] = useState<Loaded[] | null>(null);
  const picks = usePickStore((s) => s.picks);
  const [hover, setHover] = useState<PickedEntity | null>(null);
  const { camera, gl, size } = useThree();
  const frame = useMemo(() => (request.frame ? objectWorldMatrix(model, request.frame) : new Matrix4()), [model, request.frame]);

  useEffect(() => {
    let alive = true;
    const engine = engineId ? getActiveEngine(engineId) : null;
    if (!engine) return;
    Promise.all(request.objects.map(async (objectId) => ({ objectId, topo: await engine.topology(model, objectId) })))
      .then((all) => {
        if (!alive) return;
        setLoaded(all);
        usePickStore.getState().setReady(true);
        if (request.preselect) {
          const pre = all.flatMap(({ objectId, topo }) =>
            request.preselect!(objectId, topo.edges).map((index) => ({ objectId, kind: 'edge' as const, index, edge: topo.edges[index] })),
          );
          usePickStore.getState().setPicks(pre);
        }
      })
      .catch((e: Error) => {
        if (!alive) return;
        useSceneStore.getState().reportError(`면·모서리를 불러오지 못했습니다: ${e.message}`);
        usePickStore.getState().cancel();
      });
    return () => {
      alive = false;
    };
    // 요청이 바뀔 때만 다시 불러온다 (고르는 동안 모델은 바뀌지 않음)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [request, engineId]);

  // 그릴 three 객체 (위상 좌표계 → frame 으로 월드)
  const scene = useMemo(() => {
    if (!loaded) return null;
    const faces: { mesh: Mesh; entity: PickedEntity }[] = [];
    const edges: { line: Line; entity: PickedEntity; world: Vector3[] }[] = [];
    for (const { objectId, topo } of loaded) {
      topo.faces.forEach((face, index) => {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(face.positions, 3));
        g.setIndex(new BufferAttribute(face.indices, 1));
        const mesh = new Mesh(g, new MeshBasicMaterial({ color: COLORS.hover, transparent: true, opacity: 0, depthWrite: false, polygonOffset: true, polygonOffsetFactor: -1, polygonOffsetUnits: -1 }));
        faces.push({ mesh, entity: { objectId, kind: 'face', index, face } });
      });
      topo.edges.forEach((edge, index) => {
        const g = new BufferGeometry();
        g.setAttribute('position', new BufferAttribute(edge.points, 3));
        const line = new Line(g, new LineBasicMaterial({ color: COLORS.edge, depthTest: false, transparent: true }));
        line.renderOrder = 10;
        const world: Vector3[] = [];
        for (let i = 0; i + 2 < edge.points.length; i += 3) world.push(new Vector3(edge.points[i], edge.points[i + 1], edge.points[i + 2]).applyMatrix4(frame));
        edges.push({ line, entity: { objectId, kind: 'edge', index, edge }, world });
      });
    }
    return { faces, edges };
  }, [loaded, frame]);

  useEffect(
    () => () => {
      scene?.faces.forEach(({ mesh }) => {
        mesh.geometry.dispose();
        (mesh.material as MeshBasicMaterial).dispose();
      });
      scene?.edges.forEach(({ line }) => {
        line.geometry.dispose();
        (line.material as LineBasicMaterial).dispose();
      });
    },
    [scene],
  );

  // 강조 색
  useEffect(() => {
    if (!scene) return;
    const key = (e: PickedEntity) => `${e.objectId}:${e.kind}:${e.index}`;
    const picked = new Set(picks.map(key));
    const hk = hover ? key(hover) : '';
    for (const { mesh, entity } of scene.faces) {
      const m = mesh.material as MeshBasicMaterial;
      const k = key(entity);
      m.opacity = k === hk ? 0.35 : picked.has(k) ? 0.3 : 0;
      m.color.set(picked.has(k) ? COLORS.picked : COLORS.hover);
    }
    for (const { line, entity } of scene.edges) {
      const k = key(entity);
      (line.material as LineBasicMaterial).color.set(k === hk ? COLORS.hover : picked.has(k) ? COLORS.picked : COLORS.edge);
    }
  }, [scene, picks, hover]);

  // 포인터: 모서리(화면 거리) 먼저, 아니면 면(광선)
  const hoverRef = useRef<PickedEntity | null>(null);
  useEffect(() => {
    if (!scene) return;
    const el = gl.domElement;
    const raycaster = new Raycaster();
    const accepts = (e: PickedEntity) => (request.accept === 'any' || request.accept === e.kind) && !request.filter?.(e);
    const find = (ev: PointerEvent | MouseEvent): PickedEntity | null => {
      const r = el.getBoundingClientRect();
      const mx = ev.clientX - r.left;
      const my = ev.clientY - r.top;
      const toScreen = (p: Vector3) => {
        const v = p.clone().project(camera);
        return new Vector2(((v.x + 1) / 2) * size.width, ((1 - v.y) / 2) * size.height);
      };
      if (request.accept !== 'face') {
        let best: { d: number; e: PickedEntity } | null = null;
        const m = new Vector2(mx, my);
        for (const { entity, world } of scene.edges) {
          if (!accepts(entity)) continue;
          for (let i = 1; i < world.length; i++) {
            const a = toScreen(world[i - 1]!);
            const b = toScreen(world[i]!);
            const ab = b.clone().sub(a);
            const t = Math.max(0, Math.min(1, m.clone().sub(a).dot(ab) / Math.max(ab.lengthSq(), 1e-9)));
            const d = a.add(ab.multiplyScalar(t)).distanceTo(m);
            if (d < EDGE_PX && (!best || d < best.d)) best = { d, e: entity };
          }
        }
        if (best) return best.e;
      }
      if (request.accept === 'edge') return null;
      raycaster.setFromCamera(new Vector2((mx / size.width) * 2 - 1, -(my / size.height) * 2 + 1), camera);
      const meshes = scene.faces.map((f) => f.mesh);
      meshes.forEach((mesh) => {
        mesh.matrixAutoUpdate = false;
        mesh.matrixWorld.copy(frame);
      });
      const hit = raycaster.intersectObjects(meshes, false)[0];
      const face = hit ? scene.faces.find((f) => f.mesh === hit.object)?.entity : undefined;
      return face && accepts(face) ? face : null;
    };
    const move = (ev: PointerEvent) => {
      const e = find(ev);
      if (e?.objectId !== hoverRef.current?.objectId || e?.index !== hoverRef.current?.index || e?.kind !== hoverRef.current?.kind) {
        hoverRef.current = e;
        setHover(e);
      }
      el.style.cursor = e ? 'pointer' : '';
    };
    let downAt: { x: number; y: number } | null = null;
    const down = (ev: PointerEvent) => {
      downAt = ev.button === 0 ? { x: ev.clientX, y: ev.clientY } : null;
    };
    const up = (ev: PointerEvent) => {
      if (!downAt || Math.hypot(ev.clientX - downAt.x, ev.clientY - downAt.y) > 4) return; // 끌기(회전)는 고르기가 아님
      downAt = null;
      const e = find(ev);
      if (e) usePickStore.getState().toggle(e);
    };
    const key = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') usePickStore.getState().cancel();
      if (ev.key === 'Enter') usePickStore.getState().finish();
    };
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointerup', up);
    window.addEventListener('keydown', key);
    return () => {
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointerup', up);
      window.removeEventListener('keydown', key);
      el.style.cursor = '';
    };
  }, [scene, request, camera, gl, size, frame]);

  if (!scene) return null;
  return (
    <group matrixAutoUpdate={false} matrix={frame}>
      {scene.faces.map(({ mesh }, i) => (
        <primitive key={`f${i}`} object={mesh} />
      ))}
      {scene.edges.map(({ line }, i) => (
        <primitive key={`e${i}`} object={line} />
      ))}
    </group>
  );
}

/** 화면 아래 안내 막대: 무엇을 고르는지, 몇 개 골랐는지, 적용·취소 */
export function PickBar() {
  const request = usePickStore((s) => s.request);
  const picks = usePickStore((s) => s.picks);
  const ready = usePickStore((s) => s.ready);
  if (!request) return null;
  return (
    <div className="pick-bar" data-testid="pick-bar" data-ready={ready} role="status">
      <span>{ready ? request.hint : '면·모서리를 계산하는 중…'}</span>
      {request.max > 1 && <span className="muted" data-testid="pick-count">고름 {picks.length}개</span>}
      {request.max > 1 && (
        <button className="ok" disabled={!picks.length} onClick={() => usePickStore.getState().finish()} data-testid="pick-done">
          ✓ 적용 (Enter)
        </button>
      )}
      <button className="cancel" onClick={() => usePickStore.getState().cancel()} data-testid="pick-cancel">
        ✕ 취소 (Esc)
      </button>
    </div>
  );
}
