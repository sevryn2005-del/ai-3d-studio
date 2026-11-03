/**
 * 서버 RenderMesh ↔ Three.js BufferGeometry 변환과 형상 키.
 *
 * 형상 키 = 도형 종류 + 파라미터. 객체 자신의 변환(위치/회전)은 포함하지 않는다.
 * 서버 메시는 객체 로컬 좌표계이므로 같은 키의 메시는 위치·회전과 무관하게 재사용할 수 있다.
 * 불리언은 하위 객체 전체(형상 키 + 부모 기준 변환)를 포함한다 → 구멍을 옮기면 키가 바뀌어 재계산.
 */
import { BufferAttribute, BufferGeometry } from 'three';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { RenderMesh } from '../../api/backend';
import type { EngineMesh } from '../engine/types';
import type { CadObject, ObjectId, Sketch, SketchPlane, Transform } from '../../cad/commandTypes';
import { resolveProfile } from '../../cad/sketch';
import { extrudeLocalMatrix } from '../../cad/sketchPlane';

/**
 * 형상 키. 돌출은 참조한 스케치 프로파일(치수·중심·평면 높이)을 포함 → 스케치 치수를 바꾸면 다시 계산된다.
 * sketches 를 넘기지 않으면 돌출 키는 프로파일 없이 만들어지므로, 돌출이 있는 모델에서는 항상 넘긴다.
 */
export function geometryKey(
  obj: CadObject,
  index: Map<ObjectId, CadObject>,
  sketches: Map<ObjectId, Sketch> = new Map(),
): string {
  if (obj.kind === 'boolean') {
    const parts = [obj.boolean.base, ...obj.boolean.tools].map((id) => {
      const child = index.get(id);
      return child ? `${geometryKey(child, index, sketches)}@${transformKey(child.transform)}` : `missing:${id}`;
    });
    return `${obj.boolean.operation}(${parts.join(';')})`;
  }
  if (obj.kind === 'extrude') {
    const sk = sketches.get(obj.extrude.sketch);
    const p = sk ? resolveProfile(sk, obj.extrude.profile) : null;
    const prof = !p ? 'missing'
      : p.type === 'rectangle' ? `rect:${p.width}x${p.height}@${p.center.join(',')},${p.z}${planeTag(p.plane)}`
      : p.type === 'polygon' ? `poly:${p.points.map((q) => q.join(',')).join(';')}@${p.z}${planeTag(p.plane)}`
      : `circle:${p.diameter}@${p.center.join(',')},${p.z}${planeTag(p.plane)}`;
    // 면 위 스케치: 붙은 면의 좌표계(돌출 객체 로컬 기준)를 키에 넣는다 → 붙은 객체가 바뀌거나 움직이면 다시 계산
    const frame = sk?.plane.type === 'face' ? `|frame:${faceFrameKey(obj, index, sketches)}` : '';
    return `extrude:${prof}|d=${obj.params.distance}${frame}`;
  }
  const params = obj.params as Record<string, number>;
  const sorted = Object.keys(params)
    .sort()
    .map((k) => `${k}=${params[k]}`);
  const edge = obj.kind === 'box' && obj.edgeFeature ? `|${obj.edgeFeature.type}:${obj.edgeFeature.size}:${obj.edgeFeature.edges}` : '';
  return `${obj.kind}:${sorted.join(',')}${edge}`;
}

function transformKey(t: Transform): string {
  return `${t.position.join(',')}|${t.rotation.join(',')}`;
}

function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export class MeshDecodeError extends Error {}

/** 서버 RenderMesh(base64) → 검증된 버퍼 */
export function decodeRenderMeshArrays(mesh: RenderMesh): EngineMesh {
  const pos = base64ToBytes(mesh.positions);
  const idx = base64ToBytes(mesh.indices);
  if (pos.byteLength !== mesh.vertexCount * 12 || idx.byteLength !== mesh.triangleCount * 12) {
    throw new MeshDecodeError(`메시 크기가 맞지 않습니다: ${mesh.objectId}`);
  }
  return validateMesh({
    objectId: mesh.objectId,
    positions: new Float32Array(pos.buffer),
    indices: new Uint32Array(idx.buffer),
    welded: false,
  });
}

/** 범위를 벗어난 인덱스를 거부한다 (GPU 에 잘못된 버퍼 전달 방지). 모든 엔진 출력에 적용. */
export function validateMesh(mesh: EngineMesh): EngineMesh {
  const vertexCount = mesh.positions.length / 3;
  if (!Number.isInteger(vertexCount) || mesh.indices.length % 3 !== 0) {
    throw new MeshDecodeError(`메시 형식이 올바르지 않습니다: ${mesh.objectId}`);
  }
  for (const i of mesh.indices) {
    if (i >= vertexCount) throw new MeshDecodeError(`잘못된 메시 인덱스: ${mesh.objectId}`);
  }
  return mesh;
}

/** 화면 표시용 지오메트리. 정점이 공유된 메시는 30° 이상 꺾이는 곳에서 법선을 분리해 모서리를 선명하게. */
export const CREASE_ANGLE = Math.PI / 6;

export function buildGeometry(mesh: EngineMesh): BufferGeometry {
  let g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(mesh.positions, 3));
  g.setIndex(new BufferAttribute(mesh.indices, 1));
  if (mesh.welded) {
    const creased = toCreasedNormals(g, CREASE_ANGLE);
    g.dispose();
    g = creased;
  } else {
    g.computeVertexNormals();
  }
  g.computeBoundingBox();
  g.computeBoundingSphere();
  return g;
}

export function decodeRenderMesh(mesh: RenderMesh): BufferGeometry {
  return buildGeometry(decodeRenderMeshArrays(mesh));
}

/** XY 는 기존 키와 같게 (캐시·테스트 호환), 다른 평면만 표시 */
function faceFrameKey(obj: Extract<CadObject, { kind: 'extrude' }>, index: Map<ObjectId, CadObject>, sketches: Map<ObjectId, Sketch>): string {
  const m = extrudeLocalMatrix({ schemaVersion: 4, units: 'mm', objects: [...index.values()], sketches: [...sketches.values()] }, obj);
  return m ? m.elements.map((v) => Math.round(v * 1e6) / 1e6 + 0).join(',') : 'missing';
}

function planeTag(plane: SketchPlane): string {
  if (plane.type === 'face') return `/face:${plane.object}.${plane.face}`;
  return plane.type === 'XY' ? '' : `/${plane.type}`;
}
