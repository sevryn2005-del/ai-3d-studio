/**
 * 스케치 UI 동작을 명령 묶음으로 바꾸는 순수 함수 (UI·테스트 공용).
 * 결과는 dispatchBatch 로 한 번에 적용한다 → 실행 취소 1번으로 되돌림.
 */
import type { CadCommand, ModelDefinition, ObjectId, Point2, Transform } from './commandTypes';
import { nextId } from './commandExecutor';
import { byId, parentMap } from './modelGraph';
import { findSketch, resolveProfile } from './sketch';
import { composeTransform } from './transformMath';

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

export type HoleResult = { ok: true; commands: CadCommand[]; holeId: ObjectId; cutId: ObjectId } | { ok: false; error: string };

/**
 * 돌출 판에 원형 관통 구멍.
 * - 구멍 스케치: 판 스케치 평면보다 1mm 아래, 돌출 거리 = 판 두께 + 2mm (위아래로 1mm 씩 넘침)
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
      : Math.hypot(dx, dy) + r + HOLE_MIN_WALL <= profile.diameter / 2;
  if (!fits) return { ok: false, error: `구멍이 판 가장자리에서 ${HOLE_MIN_WALL}mm 이상 안쪽에 있어야 합니다` };

  const { world, root } = worldPlacement(model, plate.id);

  const sketchId = nextId(model, 'sk_hole');
  const holeId = nextId(model, 'hole');
  const cutId = nextId(model, 'cut');
  const holeCount = model.objects.filter((o) => o.kind === 'extrude' && o.name.startsWith('관통 구멍')).length;
  const commands: CadCommand[] = [
    { type: 'create_sketch', id: sketchId, name: `구멍 ${holeCount + 1}`, plane: { type: 'XY', offset: sketch.plane.offset - 1 } },
    { type: 'add_circle', sketch: sketchId, id: 'c1', center: hole.center, diameter: hole.diameter },
    {
      type: 'extrude',
      id: holeId,
      name: `관통 구멍 ${holeCount + 1}`,
      sketch: sketchId,
      profile: 'c1',
      distance: plate.params.distance + 2,
      position: world.position,
    },
  ];
  if (world.rotation.some((v) => v !== 0)) commands.push({ type: 'set_transform', target: holeId, rotation: world.rotation });
  commands.push({ type: 'cut', id: cutId, base: root, tools: [holeId] });
  return { ok: true, commands, holeId, cutId };
}
