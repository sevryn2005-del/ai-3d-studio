/**
 * 분해도 (형식 v41, 솔리드웍스 Exploded View): 최상위 부품마다 화면에서만 더하는 이동량.
 * 형상 계산·메이트·내보내기·간섭 검사에는 쓰지 않는다 (설계 원본의 위치는 그대로).
 */
import type { ExplodeOffset, ModelDefinition, Vec3 } from './commandTypes';
import { topLevelObjects } from './modelGraph';

const r3 = (v: number) => Math.round(v * 1000) / 1000 + 0;

/** 부품 ID → 이동량 (없으면 [0,0,0]) */
export function explodeOffset(model: ModelDefinition, id: string): Vec3 {
  return model.explode?.find((e) => e.id === id)?.offset ?? [0, 0, 0];
}

/**
 * 자동 분해: 보이는 최상위 부품의 원점 평균(조립품 가운데)에서 각 부품 원점 쪽으로 factor 배만큼 더 벌린다.
 * 가운데에 겹친 부품(거리 0)은 차례로 위(+Z)로 spacing 씩 올린다. 부품이 하나면 빈 목록
 */
export function autoExplode(model: ModelDefinition, factor = 1, spacing = 30): ExplodeOffset[] {
  const parts = topLevelObjects(model).filter((o) => !o.hidden && !o.suppressed);
  if (parts.length < 2) return [];
  const c = [0, 1, 2].map((k) => parts.reduce((s, o) => s + o.transform.position[k]!, 0) / parts.length);
  let stacked = 0;
  return parts.flatMap((o) => {
    const d = o.transform.position.map((v, k) => v - c[k]!);
    const far = Math.hypot(d[0]!, d[1]!, d[2]!) > 1e-6;
    const offset = (far ? d.map((v) => r3(v * factor)) : [0, 0, r3(spacing * ++stacked)]) as Vec3;
    return [{ id: o.id, offset }];
  });
}
