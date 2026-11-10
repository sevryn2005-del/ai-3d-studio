/**
 * 형식 v6 피처의 공통 규칙 (실행기·미리보기·브라우저 엔진이 공유. 서버는 app/cad/features.py 가 같은 규칙):
 * 억제 판정, 패턴·대칭 사본 행렬, 쉘 검사, 구멍 도구 치수.
 */
import { Matrix4, Vector3 } from 'three';
import type { Axis, CadObject, FaceName, ModelDefinition, ObjectId, PatternDef, Point2, Shell, Sketch } from './commandTypes';
import { LIMITS } from './commandTypes';
import { findSketch, openLinePoints, profileOf } from './sketch';
import { planeMatrix } from './sketchPlane';
import { formatMm } from './units';

/**
 * 억제된 객체인지 (계산·표시·내보내기에서 빠짐).
 * 자신이 억제됐거나, 불리언의 기준(base)이 억제됐거나, 패턴의 원본이 억제됐으면 억제.
 * 불리언의 도구가 억제된 경우는 그 도구만 빠진다 (불리언 자체는 남음).
 */
export function isSuppressed(obj: CadObject, index: Map<ObjectId, CadObject>, depth = 0): boolean {
  if (obj.suppressed) return true;
  if (depth > 32) return false;
  const inner =
    obj.kind === 'boolean' ? obj.boolean.base
    : obj.kind === 'pattern' ? obj.pattern.source
    : obj.kind === 'fillet' ? obj.fillet.source
    : obj.kind === 'draft' ? obj.draft.source
    : null;
  const child = inner ? index.get(inner) : undefined;
  return child ? isSuppressed(child, index, depth + 1) : false;
}

const AXIS: Record<Axis, [number, number, number]> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };

/** 정밀(B-rep) 엔진이 필요한 모델인가: 모서리 처리·구배·STEP 이 있으면 (브라우저는 OCCT 엔진으로 계산) */
export function needsPreciseEngine(model: ModelDefinition): boolean {
  return model.objects.some(isPreciseKind);
}

function isPreciseKind(o: CadObject): boolean {
  return o.kind === 'fillet' || o.kind === 'draft' || o.kind === 'step' || (o.kind === 'pattern' && (o.pattern.type === 'face' || o.pattern.type === 'dome'));
}

/** 이 객체(하위 객체 포함)를 정밀 엔진으로 계산해야 하는가 — 브라우저 워커가 최상위 객체마다 엔진을 고른다 */
export function objectNeedsPrecise(obj: CadObject, index: Map<ObjectId, CadObject>, depth = 0): boolean {
  if (isPreciseKind(obj)) return true;
  if (depth > 32) return false;
  const kids =
    obj.kind === 'boolean' ? [obj.boolean.base, ...obj.boolean.tools]
    : obj.kind === 'pattern' ? [obj.pattern.source]
    : [];
  return kids.some((id) => {
    const c = index.get(id);
    return c ? objectNeedsPrecise(c, index, depth + 1) : false;
  });
}

/** 패턴 사본 수 (원본 포함) */
export function patternCopyCount(p: PatternDef): number {
  if (p.type === 'scale') return 1;
  if (p.type === 'mirror') return 2;
  if (p.type === 'circular' || p.type === 'curve') return p.count;
  if (p.type === 'split' || p.type === 'face' || p.type === 'dome') return 1;
  if (p.type === 'sketch') return 0; // 원 개수는 스케치에 따라 (검사는 patternError 가 스케치로)
  return p.count * (p.axis2 ? (p.count2 ?? 1) : 1);
}

/** 패턴 좌표계에서 원본(자식 변환 적용 후)에 곱할 사본 행렬들. 첫 번째 = 단위 행렬 (원본) */
/**
 * 곡선 따라 패턴 사본 행렬 (서버 features.py curve_matrices 와 같은 규칙): 열린 선을 길이로 count−1 등분한 점마다
 * 선 시작점에서 그 점으로 옮긴다. align 이면 시작 접선 → 그 점 접선만큼 평면 법선 둘레로 돌린다. 스케치 평면 좌표 → 월드(= 패턴 좌표계)
 */
export function curveMatrices(points: Point2[], plane: Matrix4, count: number, align: boolean): Matrix4[] {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i + 1 < points.length; i++) {
    const l = Math.hypot(points[i + 1]![0] - points[i]![0], points[i + 1]![1] - points[i]![1]);
    seg.push(l);
    total += l;
  }
  const at = (s: number): { p: Point2; ang: number } => {
    let i = 0;
    while (i < seg.length - 1 && s > seg[i]!) {
      s -= seg[i]!;
      i++;
    }
    const a = points[i]!;
    const b = points[i + 1]!;
    const t = seg[i]! > 0 ? Math.min(1, s / seg[i]!) : 0;
    return { p: [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t], ang: Math.atan2(b[1] - a[1], b[0] - a[0]) };
  };
  const first = at(0);
  const normal = new Vector3().setFromMatrixColumn(plane, 2).normalize();
  const world = (q: Point2) => new Vector3(q[0], q[1], 0).applyMatrix4(plane);
  const p0 = world(first.p);
  return Array.from({ length: count }, (_, k) => {
    const c = at(count > 1 ? (total * k) / (count - 1) : 0);
    const pk = world(c.p);
    const rot = align ? new Matrix4().makeRotationAxis(normal, c.ang - first.ang) : new Matrix4();
    return new Matrix4().makeTranslation(pk.x, pk.y, pk.z).multiply(rot).multiply(new Matrix4().makeTranslation(-p0.x, -p0.y, -p0.z));
  });
}

/** 곡선 패턴의 선 점과 평면 (못 쓰면 오류 글) */
export function curvePatternInput(p: Extract<PatternDef, { type: 'curve' }>, sketches: Map<ObjectId, Sketch>): { points: Point2[]; plane: Matrix4 } | string {
  const sk = sketches.get(p.sketch);
  if (!sk) return `존재하지 않는 스케치입니다: ${p.sketch}`;
  if (sk.plane.type === 'face') return '곡선 패턴의 선은 기준 평면·각도 평면·고정 평면 스케치에 있어야 합니다 (면 위 스케치는 아직)';
  const pts = openLinePoints(sk, p.path);
  if (!pts || pts.length < 2) return `'${sk.name}'에 열린 선(선·경로) '${p.path}'이(가) 없습니다`;
  return { points: pts, plane: planeMatrix(sk.plane) };
}

/** 스케치 위치 패턴의 원 중심(요소 순서)과 평면 (못 쓰면 오류 글) — 서버 sketch_pattern_input 과 같은 규칙 */
export function sketchPatternInput(p: Extract<PatternDef, { type: 'sketch' }>, sketches: Map<ObjectId, Sketch>): { centers: Point2[]; plane: Matrix4 } | string {
  const sk = sketches.get(p.sketch);
  if (!sk) return `존재하지 않는 스케치입니다: ${p.sketch}`;
  if (sk.plane.type === 'face') return '스케치 위치 패턴은 기준 평면·각도 평면·고정 평면 스케치에만 쓸 수 있습니다 (면 위 스케치는 아직)';
  const centers = sk.entities.flatMap((e) => (e.type === 'circle' ? [e.center as Point2] : []));
  if (centers.length < 2) return `'${sk.name}'에 원이 2개 이상 있어야 합니다 (원 중심마다 놓습니다)`;
  if (centers.length > LIMITS.maxPatternTotal) return `패턴 사본은 최대 ${LIMITS.maxPatternTotal}개까지 가능합니다`;
  return { centers, plane: planeMatrix(sk.plane) };
}

/** 평면 자르기: 평면 법선 축 (XY → z …) */
export const SPLIT_AXIS = { XY: 2, XZ: 1, YZ: 0 } as const;
/** 평면 자르기에서 버리는 쪽 큰 상자 [x0, y0, z0, w, d, h] (패턴 좌표계) — 서버 features.py split_cut_box 와 같은 값 */
export function splitCutBox(p: Extract<PatternDef, { type: 'split' }>): [number, number, number, number, number, number] {
  const L = LIMITS.maxCoordinate * 4;
  const lo = [-L / 2, -L / 2, -L / 2];
  const size = [L, L, L];
  const a = SPLIT_AXIS[p.plane];
  lo[a] = p.keep === 'positive' ? p.offset - L : p.offset;
  return [lo[0]!, lo[1]!, lo[2]!, size[0]!, size[1]!, size[2]!];
}

export function patternMatrices(p: PatternDef, sketches: Map<ObjectId, Sketch> = new Map()): Matrix4[] {
  if (p.type === 'split' || p.type === 'face' || p.type === 'dome') return [new Matrix4()]; // 자르기·면 이동은 사본이 아니다 (엔진이 원본을 바꾼다)
  if (p.type === 'sketch') {
    const input = sketchPatternInput(p, sketches);
    if (typeof input === 'string') return [new Matrix4()];
    const world = (q: Point2) => new Vector3(q[0], q[1], 0).applyMatrix4(input.plane);
    const p0 = world(input.centers[0]!);
    return input.centers.map((c) => {
      const d = world(c).sub(p0);
      return new Matrix4().makeTranslation(d.x, d.y, d.z);
    });
  }
  if (p.type === 'curve') {
    const input = curvePatternInput(p, sketches);
    return typeof input === 'string' ? [new Matrix4()] : curveMatrices(input.points, input.plane, p.count, p.align);
  }
  if (p.type === 'scale') return [new Matrix4().makeScale(p.x, p.y, p.z)]; // 원본 대신 배율 적용본 하나
  if (p.type === 'mirror') {
    const n = new Vector3(...{ XY: AXIS.z, XZ: AXIS.y, YZ: AXIS.x }[p.plane]);
    // 반사 R = I − 2nnᵀ, 평면이 원점에서 offset 만큼 → T(offset·n) · R · T(−offset·n)
    const r = new Matrix4().set(
      1 - 2 * n.x * n.x, -2 * n.x * n.y, -2 * n.x * n.z, 0,
      -2 * n.y * n.x, 1 - 2 * n.y * n.y, -2 * n.y * n.z, 0,
      -2 * n.z * n.x, -2 * n.z * n.y, 1 - 2 * n.z * n.z, 0,
      0, 0, 0, 1,
    );
    const t = n.clone().multiplyScalar(p.offset);
    const m = new Matrix4().makeTranslation(t.x, t.y, t.z).multiply(r).multiply(new Matrix4().makeTranslation(-t.x, -t.y, -t.z));
    return [new Matrix4(), m];
  }
  if (p.type === 'circular') {
    const step = p.angle >= 360 ? 360 / p.count : p.count > 1 ? p.angle / (p.count - 1) : 0;
    const axis = new Vector3(...AXIS[p.axis]);
    return Array.from({ length: p.count }, (_, k) => new Matrix4().makeRotationAxis(axis, (k * step * Math.PI) / 180));
  }
  const out: Matrix4[] = [];
  const a = new Vector3(...AXIS[p.axis]).multiplyScalar(p.spacing);
  const b = p.axis2 ? new Vector3(...AXIS[p.axis2]).multiplyScalar(p.spacing2 ?? 0) : new Vector3();
  const n2 = p.axis2 ? (p.count2 ?? 1) : 1;
  for (let j = 0; j < n2; j++)
    for (let i = 0; i < p.count; i++) {
      const d = a.clone().multiplyScalar(i).add(b.clone().multiplyScalar(j));
      out.push(new Matrix4().makeTranslation(d.x, d.y, d.z));
    }
  return out;
}

/** 패턴 정의 검사 (실행기·파일 검증). 문제 없으면 null */
export function patternError(p: PatternDef, sketches?: Map<ObjectId, Sketch>): string | null {
  if (p.type === 'sketch') {
    if (!sketches) return null;
    const input = sketchPatternInput(p, sketches);
    return typeof input === 'string' ? input : null;
  }
  if (p.type === 'curve') {
    if (p.count < 2) return '곡선 패턴은 개수가 2 이상이어야 합니다';
    if (sketches) {
      const input = curvePatternInput(p, sketches);
      if (typeof input === 'string') return input;
    }
  }
  if (p.type === 'linear') {
    if (p.count < 2 && !(p.axis2 && (p.count2 ?? 1) >= 2)) return '선형 패턴은 개수가 2 이상이어야 합니다';
    if (Math.abs(p.spacing) < LIMITS.minDimension) return `간격은 ${LIMITS.minDimension}mm 이상이어야 합니다`;
    if (p.axis2) {
      if (p.axis2 === p.axis) return '두 번째 방향은 첫 번째와 다른 축이어야 합니다';
      if (p.count2 === undefined || p.spacing2 === undefined) return '두 번째 방향에는 개수와 간격이 필요합니다';
      if (Math.abs(p.spacing2) < LIMITS.minDimension) return `간격은 ${LIMITS.minDimension}mm 이상이어야 합니다`;
    } else if (p.count2 !== undefined || p.spacing2 !== undefined) return '두 번째 방향 축(axis2)이 없습니다';
  }
  if (p.type === 'circular' && p.count < 2) return '원형 패턴은 개수가 2 이상이어야 합니다';
  if (patternCopyCount(p) > LIMITS.maxPatternTotal) return `패턴 사본은 최대 ${LIMITS.maxPatternTotal}개까지 가능합니다`;
  return null;
}

/** 쉘을 쓸 수 있는 면 이름 */
export function shellFaces(obj: CadObject): FaceName[] {
  if (obj.kind === 'box') return ['top', 'bottom', '+X', '-X', '+Y', '-Y'];
  if (obj.kind === 'cylinder') return ['top', 'bottom'];
  if (obj.kind === 'extrude') return ['end', 'start'];
  return [];
}

/** 쉘 검사: 두께가 형상에 들어가는지, 열린 면 이름이 맞는지. 문제 없으면 null */
export function shellError(obj: CadObject, shell: Shell, model: ModelDefinition): string | null {
  const t = shell.thickness;
  const faces = shellFaces(obj);
  if (!faces.length) return '쉘은 박스·원통·돌출에만 할 수 있습니다';
  const bad = shell.open.filter((f) => !faces.includes(f));
  if (bad.length) return `열 수 없는 면입니다: ${bad.join(', ')} (가능: ${faces.join(', ')})`;
  if (new Set(shell.open).size !== shell.open.length) return '같은 면이 두 번 지정되었습니다';
  let limit = Infinity;
  if (obj.kind === 'box') {
    if (obj.edgeFeature) return '모서리 처리(필렛·모따기)한 박스에는 아직 쉘을 할 수 없습니다';
    if (shell.open.length >= 6) return '모든 면을 열 수는 없습니다';
    limit = Math.min(obj.params.width, obj.params.depth, obj.params.height) / 2;
  } else if (obj.kind === 'cylinder') {
    limit = Math.min(obj.params.radius, obj.params.height / 2);
  } else if (obj.kind === 'extrude') {
    const sk = findSketch(model, obj.extrude.sketch);
    const p = sk ? profileOf(sk, obj.extrude) : null;
    limit = Math.abs(obj.params.distance) / 2;
    if (p?.type === 'rectangle') limit = Math.min(limit, p.width / 2, p.height / 2);
    if (p?.type === 'circle') limit = Math.min(limit, p.diameter / 2);
    if (p?.type === 'polygon') limit = Math.min(limit, polygonInradiusBound(p.points));
  }
  if (t >= limit) return `쉘 두께 ${formatMm(t)}mm 가 너무 큽니다 (${formatMm(limit)}mm 보다 작아야 합니다)`;
  return null;
}

/** 다각형 안쪽으로 줄일 수 있는 두께의 대략적 상한 (넓이·둘레로 본 평균 폭의 절반) */
function polygonInradiusBound(points: [number, number][]): number {
  let area = 0;
  let perimeter = 0;
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]!;
    const [x2, y2] = points[(i + 1) % points.length]!;
    area += x1 * y2 - x2 * y1;
    perimeter += Math.hypot(x2 - x1, y2 - y1);
  }
  return Math.abs(area) / perimeter; // 볼록 다각형의 내접원 반지름 이상, 대부분 형상에서 충분히 보수적
}

/** 곡선 패턴에 쓸 수 있는 열린 선 (기준·각도·고정 평면 스케치의 선·경로) */
export function curvePathOptions(model: ModelDefinition): { sketch: string; path: string; label: string }[] {
  return model.sketches
    .filter((sk) => sk.plane.type !== 'face')
    .flatMap((sk) => sk.entities.filter((e) => e.type === 'line' || e.type === 'path').map((e) => ({ sketch: sk.id, path: e.id, label: `${sk.name} · ${e.id}` })));
}


/** 스케치 위치 패턴에 쓸 수 있는 스케치 (원 2개 이상, 면 위 스케치 제외) */
export function sketchPatternOptions(model: ModelDefinition): { id: string; label: string }[] {
  return model.sketches
    .filter((sk) => sk.plane.type !== 'face' && sk.entities.filter((e) => e.type === 'circle').length >= 2)
    .map((sk) => ({ id: sk.id, label: `${sk.name} (원 ${sk.entities.filter((e) => e.type === 'circle').length}개)` }));
}
