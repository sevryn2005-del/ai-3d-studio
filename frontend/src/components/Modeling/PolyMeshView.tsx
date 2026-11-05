import { useMemo } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { CadObject, Transform } from '../../cad/commandTypes';
import { edges, selectedFaces, triangulate, type PolyMesh } from '../../cad/polymesh';
import type { SelectMode } from '../../features/modeling/modelingStore';

const DEG = Math.PI / 180;
export const MESH_COLOR = '#b4b4b4';
export const SELECT_COLOR = '#ffa033';
export const ACTIVE_COLOR = '#ffd27a';

/** 평면 음영(면마다 법선) 삼각형 지오메트리 + 삼각형 → 원래 면 번호 (편집 모드 면 고르기) */
export function polyGeometry(m: PolyMesh): BufferGeometry {
  const tris = triangulate(m);
  const pos = new Float32Array(tris.length * 3);
  tris.forEach((v, i) => pos.set(m.verts[v]!, i * 3));
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  g.computeVertexNormals();
  const triFace: number[] = [];
  m.faces.forEach((f, fi) => {
    for (let i = 1; i + 1 < f.length; i++) triFace.push(fi);
  });
  g.userData.triFace = triFace;
  return g;
}

function edgeGeometry(m: PolyMesh, pairs: [number, number][]): BufferGeometry {
  const pos = new Float32Array(pairs.length * 6);
  pairs.forEach(([a, b], i) => {
    pos.set(m.verts[a]!, i * 6);
    pos.set(m.verts[b]!, i * 6 + 3);
  });
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  return g;
}

function pointGeometry(m: PolyMesh, idx: number[]): BufferGeometry {
  const pos = new Float32Array(idx.length * 3);
  idx.forEach((v, i) => pos.set(m.verts[v]!, i * 3));
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(pos, 3));
  return g;
}

interface Props {
  object: CadObject & { kind: 'polymesh' };
  mesh?: PolyMesh;
  transform?: Transform;
  /** 오브젝트 모드에서 고른 객체 (주황 윤곽) */
  selected: boolean;
  /** 편집 모드 대상 */
  editing: boolean;
  selVerts: number[];
  selectMode: SelectMode;
  onPick?: (e: ThreeEvent<MouseEvent>) => void;
}

/**
 * 편집 메시 객체 표시 (엔진 계산 없이 모델 데이터 그대로). 블렌더처럼:
 * - 오브젝트 모드: 회색 음영, 고른 객체는 주황 선
 * - 편집 모드: 모든 선(검정)·점, 고른 점·선·면은 주황
 */
export function PolyMeshView({ object, mesh, transform, selected, editing, selVerts, selectMode, onPick }: Props) {
  const m = mesh ?? object.polymesh;
  const t = transform ?? object.transform;
  const geo = useMemo(() => polyGeometry(m), [m]);
  const allEdges = useMemo(() => edges(m), [m]);
  const edgeGeo = useMemo(() => edgeGeometry(m, allEdges), [m, allEdges]);
  const sel = useMemo(() => new Set(selVerts), [selVerts]);
  const selEdgeGeo = useMemo(
    () => (editing ? edgeGeometry(m, allEdges.filter(([a, b]) => sel.has(a) && sel.has(b))) : null),
    [editing, m, allEdges, sel],
  );
  const selFaceGeo = useMemo(() => {
    if (!editing || selectMode !== 'face') return null;
    const faces = selectedFaces(m, sel);
    return faces.length ? polyGeometry({ verts: m.verts, faces: faces.map((i) => m.faces[i]!) }) : null;
  }, [editing, selectMode, m, sel]);
  const pointGeo = useMemo(() => (editing && selectMode === 'vert' ? pointGeometry(m, m.verts.map((_, i) => i)) : null), [editing, selectMode, m]);
  const selPointGeo = useMemo(() => (editing && selectMode === 'vert' ? pointGeometry(m, selVerts.filter((v) => v < m.verts.length)) : null), [editing, selectMode, m, selVerts]);

  if (object.hidden) return null;
  return (
    <group
      position={t.position}
      rotation={[t.rotation[0] * DEG, t.rotation[1] * DEG, t.rotation[2] * DEG, 'XYZ']}
      userData={{ cadObject: object.id }}
    >
      <mesh
        geometry={geo}
        name={editing ? 'polymesh-edit' : `polymesh-${object.id}`}
        userData={{ objectId: object.id }}
        onClick={onPick}
      >
        <meshStandardMaterial color={object.color ?? MESH_COLOR} flatShading side={2} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
      </mesh>
      {(editing || selected) && (
        <lineSegments geometry={edgeGeo} raycast={() => null}>
          <lineBasicMaterial color={editing ? '#111111' : SELECT_COLOR} />
        </lineSegments>
      )}
      {selEdgeGeo && (
        <lineSegments geometry={selEdgeGeo} raycast={() => null}>
          <lineBasicMaterial color={SELECT_COLOR} />
        </lineSegments>
      )}
      {selFaceGeo && (
        <mesh geometry={selFaceGeo} raycast={() => null}>
          <meshBasicMaterial color={SELECT_COLOR} transparent opacity={0.35} depthWrite={false} polygonOffset polygonOffsetFactor={-1} side={2} />
        </mesh>
      )}
      {pointGeo && (
        <points geometry={pointGeo} raycast={() => null}>
          <pointsMaterial color="#111111" size={6} sizeAttenuation={false} />
        </points>
      )}
      {selPointGeo && (
        <points geometry={selPointGeo} raycast={() => null}>
          <pointsMaterial color={SELECT_COLOR} size={8} sizeAttenuation={false} depthTest={false} />
        </points>
      )}
    </group>
  );
}
