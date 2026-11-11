import { useEffect, useMemo } from 'react';
import { BufferAttribute, BufferGeometry } from 'three';
import type { ThreeEvent } from '@react-three/fiber';
import type { CadObject, Transform } from '../../cad/commandTypes';
import { DEFAULT_MATERIAL } from '../../cad/commandTypes';
import { edges, selectedFaces, triangulate, type PolyMesh } from '../../cad/polymesh';
import type { SelectMode } from '../../features/modeling/modelingStore';
import { evaluateModifiers } from '../../cad/polymeshModifiers';
import { textureUvGeometry } from '../../cad/textureMap';
import { useImageTexture } from '../Viewport/useImageTexture';

const DEG = Math.PI / 180;
export const MESH_COLOR = '#b4b4b4';
export const SELECT_COLOR = '#ffa033';
export const ACTIVE_COLOR = '#ffd27a';

/** 부드러운 음영: 점을 공유하는 삼각형 지오메트리 (점 법선 = 이웃 면 평균). mask 가 있으면 가린 점을 어둡게 (점 색) */
function smoothGeometry(m: PolyMesh, mask?: number[] | null): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(Float32Array.from(m.verts.flat()), 3));
  if (mask && mask.length === m.verts.length) {
    g.setAttribute('color', new BufferAttribute(Float32Array.from(mask.flatMap((v) => { const c = 1 - 0.75 * v; return [c, c, c]; })), 3));
  }
  g.setIndex(triangulate(m));
  g.computeVertexNormals();
  return g;
}

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
  /** 스컬프트 모드: 부드러운 음영으로 보기 (저장된 음영 설정과 무관) */
  smoothDisplay?: boolean;
  /** 스컬프트 마스크 (원본 점 기준, 모디파이어가 없을 때만 보인다) */
  mask?: number[] | null;
  onPick?: (e: ThreeEvent<MouseEvent>) => void;
}

/**
 * 편집 메시 객체 표시 (엔진 계산 없이 모델 데이터 그대로). 블렌더처럼:
 * - 오브젝트 모드: 회색 음영, 고른 객체는 주황 선
 * - 편집 모드: 모든 선(검정)·점, 고른 점·선·면은 주황
 */
export function PolyMeshView({ object, mesh, transform, selected, editing, selVerts, selectMode, onPick, smoothDisplay, mask }: Props) {
  const smooth = !!object.smooth || !!smoothDisplay;
  const m = mesh ?? object.polymesh;
  const t = transform ?? object.transform;
  const geo = useMemo(() => polyGeometry(m), [m]);
  // 모디파이어 스택 결과 (형식 v22). 편집 모드에서는 원본이 "케이지"(선·반투명 면)로, 결과가 음영으로 보인다
  const hasMods = !!object.modifiers?.length;
  const result = useMemo(() => (hasMods ? evaluateModifiers(m, object.modifiers) : m), [m, object.modifiers, hasMods]);
  const showMask = !hasMods && !!mask;
  const shaded = useMemo(() => (smooth ? smoothGeometry(result, showMask ? mask : null) : hasMods ? polyGeometry(result) : geo), [result, smooth, hasMods, geo, showMask, mask]);
  // 텍스처 (형식 v30): 객체 로컬 박스 투영 — 설계 모드 화면·GLB 와 같은 규칙. 마스크 보기 중에는 끈다
  const map = useImageTexture(showMask ? undefined : object.texture?.image);
  const tile = object.texture?.tile;
  const projection = object.texture?.projection;
  const texturedGeo = useMemo(() => (map && tile ? textureUvGeometry(shaded, { tile, projection }) : null), [map, tile, projection, shaded]);
  useEffect(() => () => texturedGeo?.dispose(), [texturedGeo]);
  const resultEdges = useMemo(() => (hasMods && selected && !editing ? edgeGeometry(result, edges(result)) : null), [hasMods, selected, editing, result]);
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
      {/* 음영 결과 (모디파이어·부드러운 음영 반영). 편집 모드에서 모디파이어가 있으면 고르기는 아래 케이지가 받는다 */}
      {(!editing || hasMods || smooth) && (
        <mesh
          geometry={texturedGeo ?? shaded}
          name={editing ? 'polymesh-result' : `polymesh-${object.id}`}
          userData={{ objectId: object.id }}
          onClick={editing ? undefined : onPick}
          raycast={editing ? () => null : undefined}
        >
          <meshStandardMaterial key={`${smooth ? 'smooth' : 'flat'}${showMask ? '-mask' : ''}${map ? '-tex' : ''}`} vertexColors={showMask && smooth} map={map} color={object.color ?? (map ? '#ffffff' : MESH_COLOR)} metalness={object.material?.metallic ?? DEFAULT_MATERIAL.metallic} roughness={object.material?.roughness ?? DEFAULT_MATERIAL.roughness} flatShading={!smooth} side={2} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
        </mesh>
      )}
      {editing && (
        <mesh geometry={geo} name="polymesh-edit" userData={{ objectId: object.id }} onClick={onPick}>
          {hasMods || object.smooth ? (
            <meshBasicMaterial color="#9fb4d0" transparent opacity={hasMods ? 0.12 : 0.01} depthWrite={false} side={2} />
          ) : (
            <meshStandardMaterial color={object.color ?? MESH_COLOR} metalness={object.material?.metallic ?? DEFAULT_MATERIAL.metallic} roughness={object.material?.roughness ?? DEFAULT_MATERIAL.roughness} flatShading side={2} polygonOffset polygonOffsetFactor={1} polygonOffsetUnits={1} />
          )}
        </mesh>
      )}
      {resultEdges && (
        <lineSegments geometry={resultEdges} raycast={() => null}>
          <lineBasicMaterial color={SELECT_COLOR} transparent opacity={0.35} />
        </lineSegments>
      )}
      {(editing || (selected && !hasMods)) && (
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
