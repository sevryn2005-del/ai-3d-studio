/**
 * 스케치 조회·검증 헬퍼 (실행기·그래프 검증·CAD 엔진·UI 공용).
 * 치수는 이름 붙은 파라미터: 사각형 → `ID.width`, `ID.height`, 원 → `ID.diameter`.
 */
import type { CadObject, DimensionKind, ModelDefinition, ObjectId, Point2, Sketch, SketchEntity, SketchPlane } from './commandTypes';
import { CHECK_TOLERANCE, constraintError, constraintResiduals, polygonError } from './solver';

export const REQUIRED_DIMENSIONS: Record<SketchEntity['type'], DimensionKind[]> = {
  rectangle: ['width', 'height'],
  circle: ['diameter'],
  polygon: [], // 다각형은 꼭짓점 좌표 + 구속(constraints)
  line: [], // 구성선: 끝점 좌표 + 구속. 형상을 만들지 않음
  slot: ['length', 'width'], // 반원 중심 거리, 폭
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
  | { type: 'circle'; center: Point2; diameter: number; z: number; plane: SketchPlane }
  | { type: 'polygon'; points: Point2[]; center: Point2; width: number; height: number; z: number; plane: SketchPlane }
  | { type: 'slot'; center: Point2; length: number; width: number; angle: number; z: number; plane: SketchPlane };

/** 슬롯 윤곽 (반원마다 segs 개 점, 반시계). 미리보기·바운딩 크기용 — 엔진은 정확한 원호/다각형 근사를 따로 만든다 */
export function slotOutline(p: { center: Point2; length: number; width: number; angle: number }, segs = 16): Point2[] {
  const a = (p.angle * Math.PI) / 180;
  const r = p.width / 2;
  const out: Point2[] = [];
  for (const [end, start] of [[p.length / 2, -Math.PI / 2], [-p.length / 2, Math.PI / 2]] as const) {
    for (let i = 0; i <= segs; i++) {
      const t = start + (i / segs) * Math.PI;
      const lx = end + r * Math.cos(t);
      const ly = r * Math.sin(t);
      out.push([p.center[0] + lx * Math.cos(a) - ly * Math.sin(a), p.center[1] + lx * Math.sin(a) + ly * Math.cos(a)]);
    }
  }
  return out;
}

/** 단면의 바운딩 박스 (평면 좌표): 중심·폭(u)·높이(v). 크기 표시·회전 반지름용 */
export function profileBounds(p: Profile): { center: Point2; width: number; height: number } {
  if (p.type === 'circle') return { center: p.center, width: p.diameter, height: p.diameter };
  if (p.type === 'slot') {
    const [hu, hv] = slotHalfExtent(p);
    return { center: p.center, width: 2 * hu, height: 2 * hv };
  }
  return { center: p.center, width: p.width, height: p.height };
}

/** 슬롯 축 방향 바운딩 반폭 [u, v] */
export function slotHalfExtent(p: { length: number; width: number; angle: number }): [number, number] {
  const a = (p.angle * Math.PI) / 180;
  const r = p.width / 2;
  return [Math.abs(Math.cos(a)) * (p.length / 2) + r, Math.abs(Math.sin(a)) * (p.length / 2) + r];
}

export function resolveProfile(sketch: Sketch, entityId: ObjectId): Profile | null {
  const e = sketch.entities.find((x) => x.id === entityId);
  if (!e || e.type === 'line') return null; // 구성선은 단면이 아니다
  const z = sketch.plane.offset;
  const plane = sketch.plane;
  if (e.type === 'polygon') {
    // center·width·height = 바운딩 박스 (크기 표시·구멍 위치 기본값용). 형상은 points 그대로
    const xs = e.points.map((p) => p[0]);
    const ys = e.points.map((p) => p[1]);
    const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
    return { type: 'polygon', points: e.points, center: [(x0 + x1) / 2, (y0 + y1) / 2], width: x1 - x0, height: y1 - y0, z, plane };
  }
  if (e.type === 'rectangle') {
    const width = dimensionValue(sketch, e.id, 'width');
    const height = dimensionValue(sketch, e.id, 'height');
    return width && height ? { type: 'rectangle', center: e.center, width, height, z, plane } : null;
  }
  if (e.type === 'slot') {
    const length = dimensionValue(sketch, e.id, 'length');
    const width = dimensionValue(sketch, e.id, 'width');
    return length && width ? { type: 'slot', center: e.center, length, width, angle: e.angle, z, plane } : null;
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
    if (e.type === 'polygon') {
      const err = polygonError(e.points);
      if (err) errors.push(`${sketch.id}: ${e.id} ${err}`);
    }
  }
  // 구속: 참조 형식 + 저장된 좌표가 구속을 만족하는지 (해석기가 푼 결과만 저장된다)
  const cids = new Set<string>();
  for (const c of sketch.constraints) {
    if (cids.has(c.id)) errors.push(`${sketch.id}: 구속 ID 가 중복되었습니다: ${c.id}`);
    cids.add(c.id);
    const err = constraintError(sketch, c);
    if (err) errors.push(`${sketch.id}: 구속 ${c.id}: ${err}`);
  }
  for (const [id, res] of constraintResiduals(sketch)) {
    if (res > CHECK_TOLERANCE) errors.push(`${sketch.id}: 구속 ${id} 을(를) 만족하지 않습니다 (오차 ${res.toExponential(1)})`);
  }
  for (const e of sketch.entities) {
    for (const k of REQUIRED_DIMENSIONS[e.type]) {
      if (!sketch.dimensions.some((d) => d.entity === e.id && d.kind === k)) errors.push(`${sketch.id}: ${e.id} 의 ${k} 치수가 없습니다`);
    }
  }
  return errors;
}

/** 스케치를 참조하는 피처(돌출·회전)의 참조. 다른 종류면 null */
export function sketchFeatureRef(obj: CadObject): { sketch: ObjectId; profile: ObjectId } | null {
  if (obj.kind === 'extrude') return obj.extrude;
  if (obj.kind === 'revolve') return obj.revolve;
  return null;
}

/** 회전 프로파일이 축(u = 0)의 한쪽(u ≥ 0)에 있는지. 문제가 없으면 null */
export function revolveProfileError(p: Profile): string | null {
  const minU =
    p.type === 'polygon'
      ? Math.min(...p.points.map((q) => q[0]))
      : p.type === 'circle'
        ? p.center[0] - p.diameter / 2
        : p.type === 'slot'
          ? p.center[0] - slotHalfExtent(p)[0]
          : p.center[0] - p.width / 2;
  return minU < -1e-9 ? `회전 프로파일은 회전축(스케치 v 축, u = 0)의 한쪽(u ≥ 0)에 있어야 합니다 (지금 u 최소 ${Math.round(minU * 1000) / 1000})` : null;
}
