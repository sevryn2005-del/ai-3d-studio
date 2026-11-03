import type { ModelDefinition, Vec3 } from './commandTypes';
import { localSize } from './objectKinds';
import { topLevelObjects } from './modelGraph';

export const PLACEMENT_GAP = 10; // mm

/**
 * 새 객체를 기존 객체와 겹치지 않게 X축 방향 오른쪽에 놓을 위치(바닥면 중심).
 * 회전은 보수적으로 고려해 XY 대각선 길이를 반경으로 사용한다.
 */
export function nextFreePosition(model: ModelDefinition, newSizeX: number): Vec3 {
  if (model.objects.length === 0) return [0, 0, 0];
  let maxX = -Infinity;
  for (const o of topLevelObjects(model)) {
    const [sx, sy] = localSize(o, model);
    maxX = Math.max(maxX, o.transform.position[0] + Math.hypot(sx, sy) / 2);
  }
  return [Math.ceil(maxX + PLACEMENT_GAP + newSizeX / 2), 0, 0];
}
