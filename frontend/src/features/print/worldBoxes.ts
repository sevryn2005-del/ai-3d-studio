/**
 * 최상위 객체별 월드 바운딩 박스 (mm).
 * CAD 엔진(서버·브라우저)이 계산한 메시가 있으면 그 정점을 객체 변환으로 옮겨 정확히 구하고,
 * 아직 없으면 도형의 로컬 상자 꼭짓점으로 근사한다 (회전한 원통·구는 실제보다 조금 크게 나올 수 있음).
 */
import { Matrix4, Vector3, type BufferGeometry } from 'three';
import type { CadObject, ModelDefinition, ObjectId, Vec3 } from '../../cad/commandTypes';
import { byId, topLevelObjects } from '../../cad/modelGraph';
import { localSize } from '../../cad/objectKinds';
import type { WorldBox } from '../../cad/printCheck';
import { toMatrix } from '../../cad/transformMath';
import { geometryKey } from '../backend/renderMesh';

export function boxFromGeometry(geometry: BufferGeometry, matrix: Matrix4): WorldBox {
  const pos = geometry.getAttribute('position');
  const v = new Vector3();
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (let i = 0; i < pos.count; i++) {
    v.fromBufferAttribute(pos, i).applyMatrix4(matrix);
    for (let k = 0; k < 3; k++) {
      const c = v.getComponent(k);
      if (c < min[k]!) min[k] = c;
      if (c > max[k]!) max[k] = c;
    }
  }
  return { min, max };
}

/** 메시가 없을 때: 로컬 상자의 8 꼭짓점을 변환 (불리언은 기준 객체 크기로 근사) */
export function approximateBox(obj: CadObject, model: ModelDefinition, matrix: Matrix4): WorldBox {
  const [sx, sy, sz] = localSize(obj, model);
  const min: Vec3 = [Infinity, Infinity, Infinity];
  const max: Vec3 = [-Infinity, -Infinity, -Infinity];
  for (const x of [-sx / 2, sx / 2])
    for (const y of [-sy / 2, sy / 2])
      for (const z of [0, sz]) {
        const p = new Vector3(x, y, z).applyMatrix4(matrix);
        for (let k = 0; k < 3; k++) {
          min[k] = Math.min(min[k]!, p.getComponent(k));
          max[k] = Math.max(max[k]!, p.getComponent(k));
        }
      }
  return { min, max };
}

export function worldBoxes(
  model: ModelDefinition,
  geometries: Record<string, BufferGeometry>,
): { boxes: Map<ObjectId, WorldBox>; exact: boolean } {
  const index = byId(model);
  const boxes = new Map<ObjectId, WorldBox>();
  let exact = true;
  for (const obj of topLevelObjects(model)) {
    const matrix = toMatrix(obj.transform);
    const g = geometries[geometryKey(obj, index)];
    if (g) boxes.set(obj.id, boxFromGeometry(g, matrix));
    else {
      exact = false;
      boxes.set(obj.id, approximateBox(obj, model, matrix));
    }
  }
  return { boxes, exact };
}
