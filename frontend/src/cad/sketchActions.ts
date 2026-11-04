/**
 * 스케치 UI 동작을 명령 묶음으로 바꾸는 순수 함수 (UI·테스트 공용).
 * 결과는 dispatchBatch 로 한 번에 적용한다 → 실행 취소 1번으로 되돌림.
 */
import type { CadCommand, ModelDefinition, ObjectId, Point2, Transform } from './commandTypes';
import { nextId } from './commandExecutor';
import { byId, parentMap } from './modelGraph';
import { findSketch, resolveProfile, slotOutline } from './sketch';
import { composeTransform } from './transformMath';
import { polygonError } from './solver';
import { openPathError } from './curves';

/** 객체의 월드 변환과 그 객체를 포함한 최상위 객체 (불리언 자식이면 상위 변환을 합성) */
export function worldPlacement(model: ModelDefinition, id: ObjectId): { world: Transform; root: ObjectId } {
  const index = byId(model);
  const parents = parentMap(model);
  let world: Transform = index.get(id)!.transform;
  let root = id;
  for (let p = parents.get(root); p; p = parents.get(root)) {
    world = composeTransform(index.get(p)!.transform, world);
    root = p;
  }
  return { world, root };
}

/** 툴바 "사각형 스케치": 스케치 + 사각형(기본 60×40) */
export function rectangleSketchCommands(model: ModelDefinition, width = 60, height = 40): { sketchId: ObjectId; commands: CadCommand[] } {
  const sketchId = nextId(model, 'sketch');
  return {
    sketchId,
    commands: [
      { type: 'create_sketch', id: sketchId },
      { type: 'add_rectangle', sketch: sketchId, id: 'r1', width, height },
    ],
  };
}

/** 관통 구멍을 넣을 때 판 바깥과 남겨야 하는 최소 두께 (mm). 접하면 형상이 매니폴드가 아니게 된다. */
export const HOLE_MIN_WALL = 0.5;

/** 점이 다각형 안에 있는가 (짝-홀 규칙) */
function pointInPolygon([x, y]: Point2, pts: Point2[]): boolean {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]!;
    const [xj, yj] = pts[j]!;
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** 점에서 다각형 변까지의 최소 거리 */
function edgeDistance(p: Point2, pts: Point2[]): number {
  let best = Infinity;
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i]!;
    const b = pts[(i + 1) % pts.length]!;
    const [vx, vy] = [b[0] - a[0], b[1] - a[1]];
    const t = Math.max(0, Math.min(1, ((p[0] - a[0]) * vx + (p[1] - a[1]) * vy) / (vx * vx + vy * vy || 1)));
    best = Math.min(best, Math.hypot(p[0] - (a[0] + t * vx), p[1] - (a[1] + t * vy)));
  }
  return best;
}

export type HoleResult = { ok: true; commands: CadCommand[]; holeId: ObjectId; cutId: ObjectId } | { ok: false; error: string };

/**
 * 돌출 판에 원형 관통 구멍.
 * - 구멍 스케치: 판 스케치와 같은 평면(기준 평면·면 평면 모두)에서 판 바깥으로 1mm, 돌출 거리 = 판 두께 + 2mm
 *   (위아래로 1mm 씩 넘침). 판이 반대 방향(음수 거리)으로 돌출됐으면 구멍도 같은 방향으로.
 * - 구멍 객체는 판의 월드 변환을 그대로 받는다 (판이 불리언 안에 있으면 상위 변환을 합성)
 * - 최상위 객체(판 자신 또는 판을 포함한 불리언)에서 구멍을 뺀다
 * center 는 판 스케치 평면 좌표 (mm).
 */
export function throughHoleCommands(
  model: ModelDefinition,
  plateId: ObjectId,
  hole: { center: Point2; diameter: number },
): HoleResult {
  const index = byId(model);
  const plate = index.get(plateId);
  if (!plate || plate.kind !== 'extrude') return { ok: false, error: '돌출 객체에만 구멍을 낼 수 있습니다' };
  const sketch = findSketch(model, plate.extrude.sketch);
  const profile = sketch ? resolveProfile(sketch, plate.extrude.profile) : null;
  if (!sketch || !profile) return { ok: false, error: '판의 스케치 치수가 완전하지 않습니다' };

  const r = hole.diameter / 2;
  const [dx, dy] = [hole.center[0] - profile.center[0], hole.center[1] - profile.center[1]];
  const fits =
    profile.type === 'rectangle'
      ? Math.abs(dx) + r + HOLE_MIN_WALL <= profile.width / 2 && Math.abs(dy) + r + HOLE_MIN_WALL <= profile.height / 2
      : profile.type === 'circle'
        ? Math.hypot(dx, dy) + r + HOLE_MIN_WALL <= profile.diameter / 2
        : profile.type === 'slot'
          ? (() => {
              const pts = slotOutline(profile, 24);
              return pointInPolygon(hole.center, pts) && edgeDistance(hole.center, pts) >= r + HOLE_MIN_WALL;
            })()
          : pointInPolygon(hole.center, profile.points) && edgeDistance(hole.center, profile.points) >= r + HOLE_MIN_WALL;
  if (!fits) return { ok: false, error: `구멍이 판 가장자리에서 ${HOLE_MIN_WALL}mm 이상 안쪽에 있어야 합니다` };

  const { world, root } = worldPlacement(model, plate.id);
  const sign = plate.params.distance < 0 ? -1 : 1;

  const sketchId = nextId(model, 'sk_hole');
  const holeId = nextId(model, 'hole');
  const cutId = nextId(model, 'cut');
  const holeCount = model.objects.filter((o) => o.kind === 'extrude' && o.name.startsWith('관통 구멍')).length;
  const commands: CadCommand[] = [
    { type: 'create_sketch', id: sketchId, name: `구멍 ${holeCount + 1}`, plane: { ...sketch.plane, offset: sketch.plane.offset - sign } },
    { type: 'add_circle', sketch: sketchId, id: 'c1', center: hole.center, diameter: hole.diameter },
    {
      type: 'extrude',
      id: holeId,
      name: `관통 구멍 ${holeCount + 1}`,
      sketch: sketchId,
      profile: 'c1',
      distance: sign * (Math.abs(plate.params.distance) + 2),
      position: world.position,
    },
  ];
  if (world.rotation.some((v) => v !== 0)) commands.push({ type: 'set_transform', target: holeId, rotation: world.rotation });
  commands.push({ type: 'cut', id: cutId, base: root, tools: [holeId] });
  return { ok: true, commands, holeId, cutId };
}

/** 뷰포트에서 그린 도형 (스케치 평면 좌표, mm) */
export type DrawnShape =
  | { type: 'rectangle'; from: Point2; to: Point2 }
  | { type: 'circle'; center: Point2; radius: number }
  | { type: 'polygon'; points: Point2[] }
  | { type: 'path'; points: Point2[] };

/** 그리기로 만들 수 있는 최소 크기 (mm). 이보다 작으면 클릭으로 보고 무시한다 */
export const MIN_DRAWN_SIZE = 0.5;

/**
 * 그린 도형 → 명령. sketchId 가 있으면 그 스케치에 추가, 없으면 XY 평면(z=0)에 새 스케치를 만든다.
 * 너무 작으면 null.
 */
export function drawShapeCommands(model: ModelDefinition, sketchId: ObjectId | null, shape: DrawnShape): CadCommand[] | null {
  const existing = sketchId ? findSketch(model, sketchId) : undefined;
  const sid = existing?.id ?? nextId(model, 'sketch');
  const taken = new Set(existing?.entities.map((e) => e.id) ?? []);
  const entityId = (prefix: string) => {
    let n = 1;
    while (taken.has(`${prefix}${n}`)) n++;
    return `${prefix}${n}`;
  };
  const round = (v: number) => Math.round(v * 1000) / 1000;
  let add: CadCommand;
  if (shape.type === 'path') {
    const points = shape.points.map(([x, y]) => [round(x), round(y)] as Point2);
    if (points.length < 2 || openPathError(points)) return null;
    add = { type: 'add_path', sketch: sid, id: entityId('path'), points };
  } else if (shape.type === 'polygon') {
    const points = shape.points.map(([x, y]) => [round(x), round(y)] as Point2);
    if (points.length < 3 || polygonError(points)) return null; // 꼬였거나 넓이가 없으면 만들지 않는다
    add = { type: 'add_polygon', sketch: sid, id: entityId('poly'), points };
  } else if (shape.type === 'rectangle') {
    const width = round(Math.abs(shape.to[0] - shape.from[0]));
    const height = round(Math.abs(shape.to[1] - shape.from[1]));
    if (width < MIN_DRAWN_SIZE || height < MIN_DRAWN_SIZE) return null;
    const center: Point2 = [round((shape.from[0] + shape.to[0]) / 2), round((shape.from[1] + shape.to[1]) / 2)];
    add = { type: 'add_rectangle', sketch: sid, id: entityId('r'), center, width, height };
  } else {
    const diameter = round(shape.radius * 2);
    if (diameter < MIN_DRAWN_SIZE) return null;
    add = { type: 'add_circle', sketch: sid, id: entityId('c'), center: [round(shape.center[0]), round(shape.center[1])], diameter };
  }
  return existing ? [add] : [{ type: 'create_sketch', id: sid }, add];
}
