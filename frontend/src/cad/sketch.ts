/**
 * 스케치 조회·검증 헬퍼 (실행기·그래프 검증·CAD 엔진·UI 공용).
 * 치수는 이름 붙은 파라미터: 사각형 → `ID.width`, `ID.height`, 원 → `ID.diameter`.
 */
import type { CadObject, DimensionKind, ModelDefinition, ObjectId, Point2, Sketch, SketchEntity, SketchPlane } from './commandTypes';
import { CHECK_TOLERANCE, constraintError, constraintResiduals, polygonError } from './solver';
import { cornerError, openPathError, roundedPoints, thinPolygon, type Arc, type Corner } from './curves';

export const REQUIRED_DIMENSIONS: Record<SketchEntity['type'], DimensionKind[]> = {
  rectangle: ['width', 'height'],
  circle: ['diameter'],
  polygon: [], // 다각형은 꼭짓점 좌표 + 구속(constraints)
  line: [], // 구성선: 끝점 좌표 + 구속. 형상을 만들지 않음
  path: [], // 경로(형식 v10): 열린 꺾은선, 꼭짓점 좌표 + 구속
  slot: ['length', 'width'], // 반원 중심 거리, 폭
  region: [], // 영역(형식 v15): 구성 요소의 치수를 따른다
  ellipse: ['width', 'height'], // 타원(형식 v18): 방향 축 지름, 수직 지름
};

export function findSketch(model: ModelDefinition, id: ObjectId): Sketch | undefined {
  return model.sketches.find((s) => s.id === id);
}

export function dimensionValue(sketch: Sketch, entityId: ObjectId, kind: DimensionKind): number | undefined {
  return sketch.dimensions.find((d) => d.entity === entityId && d.kind === kind)?.value;
}

/** 돌출 단면: 스케치 평면 좌표의 사각형·원·다각형·슬롯 + 평면 (z = 평면 offset) */
export type BaseProfile =
  | { type: 'rectangle'; center: Point2; width: number; height: number; z: number; plane: SketchPlane }
  | { type: 'circle'; center: Point2; diameter: number; z: number; plane: SketchPlane }
  | { type: 'polygon'; points: Point2[]; corners?: Corner[]; arcs?: Arc[]; spline?: true; center: Point2; width: number; height: number; z: number; plane: SketchPlane }
  | { type: 'slot'; center: Point2; length: number; width: number; angle: number; z: number; plane: SketchPlane }
  | { type: 'ellipse'; center: Point2; width: number; height: number; angle: number; z: number; plane: SketchPlane };
/**
 * 영역 단면 (형식 v15): 단면들을 순서대로 합치고(add) 뺀 것. center·width·height = 합친(add) 단면들의 바운딩 박스
 * (빼기로 줄어들 수 있으나 크기 표시·회전 반지름용으로 충분). 엔진은 정확한 2D 불리언 (manifold CrossSection, OCCT 면 불리언)
 */
export type RegionProfile = {
  type: 'region';
  items: { op: 'add' | 'subtract'; profile: BaseProfile }[];
  center: Point2;
  width: number;
  height: number;
  z: number;
  plane: SketchPlane;
};
export type Profile = BaseProfile | RegionProfile;

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
  if (p.type === 'region') return { center: p.center, width: p.width, height: p.height };
  if (p.type === 'ellipse') {
    const [hu, hv] = ellipseHalfExtent(p);
    return { center: p.center, width: 2 * hu, height: 2 * hv };
  }
  if (p.type === 'circle') return { center: p.center, width: p.diameter, height: p.diameter };
  if (p.type === 'slot') {
    const [hu, hv] = slotHalfExtent(p);
    return { center: p.center, width: 2 * hu, height: 2 * hv };
  }
  return { center: p.center, width: p.width, height: p.height };
}

/** 타원 바운딩 반폭 [u, v] (방향 angle 로 돌린 반지름 a = width/2, b = height/2) */
export function ellipseHalfExtent(p: { width: number; height: number; angle: number }): [number, number] {
  const t = (p.angle * Math.PI) / 180;
  const [a, b] = [p.width / 2, p.height / 2];
  return [Math.hypot(a * Math.cos(t), b * Math.sin(t)), Math.hypot(a * Math.sin(t), b * Math.cos(t))];
}

/** 타원 윤곽 n 점 (반시계, 첫 점 = 방향 축 끝) — 미리보기·메시 엔진·로프트 단면 (서버 sections.ellipse_outline 과 같음) */
export function ellipseOutline(p: { center: Point2; width: number; height: number; angle: number }, n: number): Point2[] {
  const t = (p.angle * Math.PI) / 180;
  const [a, b] = [p.width / 2, p.height / 2];
  return Array.from({ length: n }, (_, k) => {
    const s = (2 * Math.PI * k) / n;
    const [x, y] = [a * Math.cos(s), b * Math.sin(s)];
    return [p.center[0] + x * Math.cos(t) - y * Math.sin(t), p.center[1] + x * Math.sin(t) + y * Math.cos(t)] as Point2;
  });
}

/** 슬롯 축 방향 바운딩 반폭 [u, v] */
export function slotHalfExtent(p: { length: number; width: number; angle: number }): [number, number] {
  const a = (p.angle * Math.PI) / 180;
  const r = p.width / 2;
  return [Math.abs(Math.cos(a)) * (p.length / 2) + r, Math.abs(Math.sin(a)) * (p.length / 2) + r];
}

export function resolveProfile(sketch: Sketch, entityId: ObjectId): Profile | null {
  const e = sketch.entities.find((x) => x.id === entityId);
  if (!e || e.type === 'line' || e.type === 'path') return null; // 구성선·경로는 닫힌 단면이 아니다
  const z = sketch.plane.offset;
  const plane = sketch.plane;
  if (e.type === 'region') {
    if (regionError(sketch, e.items, e.id)) return null;
    const items = e.items.map((it) => ({ op: it.op, profile: resolveProfile(sketch, it.entity) as BaseProfile | null }));
    if (items.some((it) => !it.profile)) return null;
    const adds = items.filter((it) => it.op === 'add').map((it) => profileBounds(it.profile!));
    const x0 = Math.min(...adds.map((b) => b.center[0] - b.width / 2));
    const x1 = Math.max(...adds.map((b) => b.center[0] + b.width / 2));
    const y0 = Math.min(...adds.map((b) => b.center[1] - b.height / 2));
    const y1 = Math.max(...adds.map((b) => b.center[1] + b.height / 2));
    return { type: 'region', items: items as RegionProfile['items'], center: [(x0 + x1) / 2, (y0 + y1) / 2], width: x1 - x0, height: y1 - y0, z, plane };
  }
  if (e.type === 'polygon') return polygonProfile(e.points, e.corners, z, plane, e.arcs, e.spline);
  if (e.type === 'rectangle') {
    const width = dimensionValue(sketch, e.id, 'width');
    const height = dimensionValue(sketch, e.id, 'height');
    return width && height ? { type: 'rectangle', center: e.center, width, height, z, plane } : null;
  }
  if (e.type === 'ellipse') {
    const width = dimensionValue(sketch, e.id, 'width');
    const height = dimensionValue(sketch, e.id, 'height');
    return width && height ? { type: 'ellipse', center: e.center, width, height, angle: e.angle, z, plane } : null;
  }
  if (e.type === 'slot') {
    const length = dimensionValue(sketch, e.id, 'length');
    const width = dimensionValue(sketch, e.id, 'width');
    return length && width ? { type: 'slot', center: e.center, length, width, angle: e.angle, z, plane } : null;
  }
  const diameter = dimensionValue(sketch, e.id, 'diameter');
  return diameter ? { type: 'circle', center: e.center, diameter, z, plane } : null;
}

/** 영역 구성 규칙 (서버 commands.region_error 와 같음): 첫 항목 add, 같은 스케치의 닫힌 요소(영역 제외), 같은 요소 두 번 금지 */
export function regionError(sketch: Sketch, items: { entity: ObjectId; op: 'add' | 'subtract' }[], self?: ObjectId): string | null {
  if (!items.length) return '영역에 요소가 없습니다';
  if (items[0]!.op !== 'add') return '영역의 첫 요소는 합치기(add)여야 합니다';
  const seen = new Set<string>();
  for (const it of items) {
    if (it.entity === self) return '영역이 자기 자신을 참조합니다';
    if (seen.has(it.entity)) return `영역에 ${it.entity} 이(가) 두 번 들어 있습니다`;
    seen.add(it.entity);
    const e = sketch.entities.find((x) => x.id === it.entity);
    if (!e) return `영역의 요소 ${it.entity} 이(가) 없습니다`;
    if (e.type === 'line' || e.type === 'path' || e.type === 'region') return `영역에는 닫힌 요소(사각형·원·다각형·슬롯)만 넣을 수 있습니다: ${it.entity}`;
  }
  return null;
}

/** 이 요소를 구성으로 쓰는 영역들 */
export function regionUsers(sketch: Sketch, entityId: ObjectId): ObjectId[] {
  return sketch.entities.flatMap((e) => (e.type === 'region' && e.items.some((it) => it.entity === entityId) ? [e.id] : []));
}

/**
 * 다각형 단면. center·width·height = (꼭짓점 처리 후 윤곽의) 바운딩 박스 — 크기 표시·구멍 위치 기본값·단면 기준점.
 * 형상은 points(+ corners) 그대로
 */
function polygonProfile(points: Point2[], corners: Corner[] | undefined, z: number, plane: SketchPlane, arcs?: Arc[], spline?: true): Profile {
  const outline = roundedPoints(points, corners, true, undefined, arcs, spline);
  const xs = outline.map((p) => p[0]);
  const ys = outline.map((p) => p[1]);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return {
    type: 'polygon',
    points,
    ...(corners?.length ? { corners } : {}),
    ...(arcs?.length ? { arcs } : {}),
    ...(spline ? { spline } : {}),
    center: [(x0 + x1) / 2, (y0 + y1) / 2],
    width: x1 - x0,
    height: y1 - y0,
    z,
    plane,
  };
}

/** 열린 선(구성선·경로)의 점 — 경로의 둥근 꺾임은 윤곽 표본으로. 열린 선이 아니면 null */
export function openLinePoints(sketch: Sketch, entityId: ObjectId): Point2[] | null {
  const e = sketch.entities.find((x) => x.id === entityId);
  if (!e || (e.type !== 'line' && e.type !== 'path')) return null;
  return e.type === 'path' ? roundedPoints(e.points, e.corners, false, undefined, e.arcs, e.spline) : roundedPoints(e.points, undefined, false);
}

/**
 * 피처 참조의 단면. thin(얇은 돌출·리브)이면 열린 선을 두께만큼 띄운 다각형, 아니면 닫힌 요소의 단면.
 * 얇은 돌출에 닫힌 요소를 주거나, 보통 돌출에 열린 선을 주면 null
 */
export function profileOf(sketch: Sketch, ref: { profile: ObjectId; thin?: number }): Profile | null {
  if (ref.thin === undefined) return resolveProfile(sketch, ref.profile);
  const pts = openLinePoints(sketch, ref.profile);
  if (!pts) return null;
  return polygonProfile(thinPolygon(pts, ref.thin), undefined, sketch.plane.offset, sketch.plane);
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
      const err = polygonError(e.points) ?? cornerError(e.points, e.corners, true, e.arcs, e.spline);
      if (err) errors.push(`${sketch.id}: ${e.id} ${err}`);
    }
    if (e.type === 'path') {
      const err = openPathError(e.points) ?? cornerError(e.points, e.corners, false, e.arcs, e.spline);
      if (err) errors.push(`${sketch.id}: ${e.id} ${err}`);
    }
    if (e.type === 'region') {
      const err = regionError(sketch, e.items, e.id);
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

/** 스케치를 참조하는 피처(돌출·회전·헬릭스)의 참조. 다른 종류면 null. 돌출은 thin(얇은 돌출)을 함께 돌려준다 */
export function sketchFeatureRef(obj: CadObject): { sketch: ObjectId; profile: ObjectId; thin?: number } | null {
  if (obj.kind === 'extrude') return obj.extrude;
  if (obj.kind === 'revolve') return obj.revolve;
  if (obj.kind === 'helix') return obj.helix;
  return null;
}

/** 피처가 참조하는 스케치 요소. open = 열린 선(스윕 경로)을 참조 */
export interface FeatureRef {
  sketch: ObjectId;
  profile: ObjectId;
  thin?: number;
  open?: boolean;
}

/** 객체가 참조하는 모든 스케치 요소 (로프트는 단면 여러 개, 스윕은 단면 + 경로). 삭제 막기·의존 순환·검증용 */
export function sketchRefs(obj: CadObject): FeatureRef[] {
  if (obj.kind === 'loft') return obj.loft.sections;
  if (obj.kind === 'sweep')
    return [
      { sketch: obj.sweep.sketch, profile: obj.sweep.profile },
      { sketch: obj.sweep.pathSketch, profile: obj.sweep.path, open: true },
    ];
  const r = sketchFeatureRef(obj);
  return r ? [r] : [];
}

/** 참조가 쓸 수 있는지: 열린 선 참조면 그 선의 점, 아니면 단면. 못 쓰면 null */
export function refTarget(sketch: Sketch, ref: FeatureRef): Profile | Point2[] | null {
  return ref.open ? openLinePoints(sketch, ref.profile) : profileOf(sketch, ref);
}

/** 회전 프로파일이 축(u = 0)의 한쪽(u ≥ 0)에 있는지. 문제가 없으면 null */
export function revolveProfileError(p: Profile): string | null {
  // 영역: 합치는 단면들이 축 한쪽에 있으면 된다 (빼기는 줄이기만 한다)
  if (p.type === 'region') return p.items.filter((it) => it.op === 'add').map((it) => revolveProfileError(it.profile)).find((e) => e) ?? null;
  const minU =
    p.type === 'polygon'
      ? Math.min(...roundedPoints(p.points, p.corners, true, undefined, p.arcs, p.spline).map((q) => q[0]))
      : p.type === 'circle'
        ? p.center[0] - p.diameter / 2
        : p.type === 'slot'
          ? p.center[0] - slotHalfExtent(p)[0]
          : p.type === 'ellipse'
            ? p.center[0] - ellipseHalfExtent(p)[0]
          : p.center[0] - p.width / 2;
  return minU < -1e-9 ? `회전 프로파일은 회전축(스케치 v 축, u = 0)의 한쪽(u ≥ 0)에 있어야 합니다 (지금 u 최소 ${Math.round(minU * 1000) / 1000})` : null;
}
