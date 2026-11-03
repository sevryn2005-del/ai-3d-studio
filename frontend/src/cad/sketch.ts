/**
 * 스케치 조회·검증 헬퍼 (실행기·그래프 검증·CAD 엔진·UI 공용).
 * 치수는 이름 붙은 파라미터: 사각형 → `ID.width`, `ID.height`, 원 → `ID.diameter`.
 */
import type { DimensionKind, ModelDefinition, ObjectId, Point2, Sketch, SketchEntity, SketchPlane } from './commandTypes';

export const REQUIRED_DIMENSIONS: Record<SketchEntity['type'], DimensionKind[]> = {
  rectangle: ['width', 'height'],
  circle: ['diameter'],
};

export function findSketch(model: ModelDefinition, id: ObjectId): Sketch | undefined {
  return model.sketches.find((s) => s.id === id);
}

export function dimensionValue(sketch: Sketch, entityId: ObjectId, kind: DimensionKind): number | undefined {
  return sketch.dimensions.find((d) => d.entity === entityId && d.kind === kind)?.value;
}

/** 돌출 단면: 스케치 평면 좌표의 사각형·원 + 평면 (z = 평면 offset) */
export type Profile =
  | { type: 'rectangle'; center: Point2; width: number; height: number; z: number; plane: SketchPlane }
  | { type: 'circle'; center: Point2; diameter: number; z: number; plane: SketchPlane };

export function resolveProfile(sketch: Sketch, entityId: ObjectId): Profile | null {
  const e = sketch.entities.find((x) => x.id === entityId);
  if (!e) return null;
  const z = sketch.plane.offset;
  const plane = sketch.plane;
  if (e.type === 'rectangle') {
    const width = dimensionValue(sketch, e.id, 'width');
    const height = dimensionValue(sketch, e.id, 'height');
    return width && height ? { type: 'rectangle', center: e.center, width, height, z, plane } : null;
  }
  const diameter = dimensionValue(sketch, e.id, 'diameter');
  return diameter ? { type: 'circle', center: e.center, diameter, z, plane } : null;
}

/** 스케치 하나의 규칙 위반 (요소 ID 중복, 치수 누락·중복·잘못된 종류, 치수 ID 형식) */
export function sketchErrors(sketch: Sketch): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  for (const e of sketch.entities) {
    if (ids.has(e.id)) errors.push(`${sketch.id}: 요소 ID 가 중복되었습니다: ${e.id}`);
    ids.add(e.id);
  }
  const seen = new Set<string>();
  for (const d of sketch.dimensions) {
    const e = sketch.entities.find((x) => x.id === d.entity);
    if (!e) errors.push(`${sketch.id}: 치수 ${d.id} 가 없는 요소를 가리킵니다: ${d.entity}`);
    else if (!REQUIRED_DIMENSIONS[e.type].includes(d.kind)) errors.push(`${sketch.id}: ${e.type} 에는 ${d.kind} 치수가 없습니다`);
    if (d.id !== `${d.entity}.${d.kind}`) errors.push(`${sketch.id}: 치수 ID 는 ${d.entity}.${d.kind} 이어야 합니다 (${d.id})`);
    if (seen.has(d.id)) errors.push(`${sketch.id}: 치수가 중복되었습니다: ${d.id}`);
    seen.add(d.id);
  }
  for (const e of sketch.entities) {
    for (const k of REQUIRED_DIMENSIONS[e.type]) {
      if (!sketch.dimensions.some((d) => d.entity === e.id && d.kind === k)) errors.push(`${sketch.id}: ${e.id} 의 ${k} 치수가 없습니다`);
    }
  }
  return errors;
}
