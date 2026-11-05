/**
 * 스케치·돌출 명령 실행 (commandExecutor 에서 위임). 순수 함수, 실패 시 원본 그대로.
 */
import type { CadCommand, CadObject, ModelDefinition, ObjectId, Sketch } from './commandTypes';
import { LIMITS } from './commandTypes';
import { idTaken, nextId, type ExecuteResult } from './commandExecutor';
import { findSketch, openLinePoints, profileOf, regionError, regionUsers, resolveProfile, revolveProfileError, sketchRefs } from './sketch';
import { cornerError, openPathError, sweepError, type Corner } from './curves';
import { helixError, helixProfilePoints, REGION_UNSUPPORTED, sweepProfilePoints } from './sections';
import { facesOf } from './sketchPlane';
import { dependencyCycle } from './modelGraph';
import { CONSTRAINT_LABEL, MIN_EDGE, constraintError, polygonError, refKind, solveSketch } from './solver';

const SKETCH_TYPES = [
  'create_sketch', 'add_rectangle', 'add_circle', 'set_dimension',
  'set_entity_center', 'delete_sketch_entity', 'set_sketch_plane', 'rename_sketch', 'delete_sketch', 'extrude',
  'add_polygon', 'move_point', 'add_constraint', 'set_constraint', 'delete_constraint', 'revolve',
  'add_line', 'add_slot', 'set_entity_angle', 'helix', 'loft', 'offset_entity',
  'add_path', 'set_corner', 'sweep', 'set_arc', 'convert_to_polygon', 'add_region', 'set_region', 'set_spline',
] as const;
type SketchCommand = Extract<CadCommand, { type: (typeof SKETCH_TYPES)[number] }>;

export function isSketchCommand(cmd: CadCommand): cmd is SketchCommand {
  return (SKETCH_TYPES as readonly string[]).includes(cmd.type);
}

const fail = (error: string): ExecuteResult => ({ ok: false, error });
const ok = (model: ModelDefinition, command: CadCommand, affectedId: ObjectId | null): ExecuteResult => ({
  ok: true, model, command, affectedId,
});

function replaceSketch(model: ModelDefinition, sketch: Sketch): ModelDefinition {
  return { ...model, sketches: model.sketches.map((s) => (s.id === sketch.id ? sketch : s)) };
}

/** 면 평면 검사: 붙을 객체·면 이름. 문제가 없으면 null */
function planeError(model: ModelDefinition, plane: Sketch['plane']): string | null {
  if (plane.type !== 'face') return null;
  const anchor = model.objects.find((o) => o.id === plane.object);
  if (!anchor) return `존재하지 않는 객체입니다: ${plane.object}`;
  const faces = facesOf(model, anchor);
  if (!faces.includes(plane.face)) return `'${anchor.name}'에는 '${plane.face}' 면이 없습니다 (있는 면: ${faces.join(', ') || '없음'})`;
  return null;
}

/** 결과 모델에 의존 순환이 생기면 실패 (예: 판의 스케치를 판 자신의 면에 붙임) */
function okUnlessCycle(next: ModelDefinition, command: CadCommand, affectedId: ObjectId | null): ExecuteResult {
  const cycle = dependencyCycle(next);
  return cycle ? fail(cycle) : ok(next, command, affectedId);
}

/**
 * 구속을 다시 풀고 결과를 반영한다. pinned = 이번 편집에서 사용자가 정한 점(움직이지 않음).
 * 풀 수 없거나 다각형이 꼬이면 실패 → 실행기가 원본을 그대로 둔다.
 */
function solvedResult(model: ModelDefinition, next: Sketch, cmd: CadCommand, affectedId: ObjectId | null, pinned: Set<string> = new Set()): ExecuteResult {
  const solved = solveSketch(next, pinned);
  if (!solved.ok) return fail(solved.error);
  for (const e of solved.sketch.entities) {
    if (e.type !== 'polygon' && e.type !== 'path') continue;
    const err = e.type === 'polygon' ? (polygonError(e.points) ?? cornerError(e.points, e.corners, true, e.arcs, e.spline)) : (openPathError(e.points) ?? cornerError(e.points, e.corners, false, e.arcs, e.spline));
    if (err) return fail(`${e.id}: ${err}`);
  }
  // 회전 피처가 쓰는 프로파일은 회전축(u = 0)을 넘으면 안 된다
  for (const o of model.objects) {
    if (o.kind !== 'revolve' || o.revolve.sketch !== next.id) continue;
    const prof = resolveProfile(solved.sketch, o.revolve.profile);
    const err = prof ? revolveProfileError(prof) : null;
    if (err) return fail(`${o.name}: ${err}`);
  }
  return ok(replaceSketch(model, solved.sketch), cmd, affectedId);
}

/** 고정(fix) 구속이 걸린 점 */
function isFixed(sketch: Sketch, point: string): boolean {
  return sketch.constraints.some((c) => c.type === 'fix' && c.refs[0] === point);
}

/** 요소를 참조하는 구속인가 (`r1`, `r1.center`, `poly.p0` …) */
function refersTo(ref: string, entity: string): boolean {
  return ref === entity || ref.startsWith(`${entity}.`);
}

function nextEntityId(sketch: Sketch, prefix: string): ObjectId {
  let n = 1;
  while (sketch.entities.some((e) => e.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** 스케치(또는 그 요소)를 참조하는 돌출 객체 이름 */
function extrudeUsers(model: ModelDefinition, sketchId: ObjectId, entityId?: ObjectId): string[] {
  return model.objects
    .filter((o) => {
      return sketchRefs(o).some((ref) => ref.sketch === sketchId && (entityId === undefined || ref.profile === entityId));
    })
    .map((o) => o.name);
}

export function executeSketchCommand(model: ModelDefinition, cmd: SketchCommand): ExecuteResult {
  switch (cmd.type) {
    case 'create_sketch': {
      if (model.sketches.length >= LIMITS.maxSketches) return fail(`스케치는 최대 ${LIMITS.maxSketches}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'sketch');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const planeErr = planeError(model, cmd.plane ?? { type: 'XY', offset: 0 });
      if (planeErr) return fail(planeErr);
      const sketch: Sketch = {
        id,
        name: cmd.name ?? `스케치 ${model.sketches.length + 1}`,
        plane: cmd.plane ?? { type: 'XY', offset: 0 },
        entities: [],
        dimensions: [],
        constraints: [],
      };
      return ok({ ...model, sketches: [...model.sketches, sketch] }, cmd, id);
    }

    case 'add_rectangle':
    case 'add_circle': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (sketch.entities.length >= LIMITS.maxSketchEntities) return fail(`스케치 요소는 최대 ${LIMITS.maxSketchEntities}개까지 가능합니다`);
      const isRect = cmd.type === 'add_rectangle';
      const id = cmd.id ?? nextEntityId(sketch, isRect ? 'rect' : 'circle');
      if (sketch.entities.some((e) => e.id === id)) return fail(`스케치에 이미 있는 요소 ID입니다: ${id}`);
      const center = cmd.center ?? [0, 0];
      const next: Sketch = isRect
        ? {
            ...sketch,
            entities: [...sketch.entities, { id, type: 'rectangle', center }],
            dimensions: [
              ...sketch.dimensions,
              { id: `${id}.width`, entity: id, kind: 'width', value: cmd.width },
              { id: `${id}.height`, entity: id, kind: 'height', value: cmd.height },
            ],
          }
        : {
            ...sketch,
            entities: [...sketch.entities, { id, type: 'circle', center }],
            dimensions: [...sketch.dimensions, { id: `${id}.diameter`, entity: id, kind: 'diameter', value: cmd.diameter }],
          };
      return ok(replaceSketch(model, next), cmd, sketch.id);
    }

    case 'set_dimension': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const dim = sketch.dimensions.find((d) => d.id === cmd.dimension);
      if (!dim) {
        const names = sketch.dimensions.map((d) => d.id).join(', ') || '없음';
        return fail(`'${sketch.name}'에 치수 ${cmd.dimension} 이(가) 없습니다 (있는 치수: ${names})`);
      }
      const next = { ...sketch, dimensions: sketch.dimensions.map((d) => (d.id === dim.id ? { ...d, value: cmd.value } : d)) };
      // 선택을 바꾸지 않는다 (돌출 객체를 보며 치수를 고치는 흐름). 원 지름은 접선 구속에 쓰이므로 다시 푼다
      return solvedResult(model, next, cmd, null);
    }

    case 'set_entity_center':
    case 'delete_sketch_entity': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (!sketch.entities.some((e) => e.id === cmd.entity)) {
        const names = sketch.entities.map((e) => e.id).join(', ') || '없음';
        return fail(`'${sketch.name}'에 요소 ${cmd.entity} 이(가) 없습니다 (있는 요소: ${names})`);
      }
      if (cmd.type === 'set_entity_center') {
        // 다각형은 바운딩 박스 중심이 center 가 되도록 통째로 옮긴다. 옮긴 점은 고정한 채 나머지 구속을 다시 푼다
        const entity = sketch.entities.find((e) => e.id === cmd.entity)!;
        if (entity.type === 'region') return fail('영역은 구성 요소를 옮기면 따라 움직입니다 (영역 자체는 옮길 수 없음)');
        const pins = new Set<string>();
        let moved = entity;
        if (entity.type === 'polygon' || entity.type === 'line' || entity.type === 'path') {
          const xs = entity.points.map((p) => p[0]);
          const ys = entity.points.map((p) => p[1]);
          const c = [(Math.min(...xs) + Math.max(...xs)) / 2, (Math.min(...ys) + Math.max(...ys)) / 2];
          const [dx, dy] = [cmd.center[0] - c[0]!, cmd.center[1] - c[1]!];
          moved =
            entity.type === 'line'
              ? { ...entity, points: entity.points.map(([x, y]) => [x + dx, y + dy]) as [[number, number], [number, number]] }
              : { ...entity, points: entity.points.map(([x, y]) => [x + dx, y + dy] as [number, number]) };
          entity.points.forEach((_, k) => pins.add(`${entity.id}.p${k}`));
        } else {
          moved = { ...entity, center: cmd.center };
          pins.add(`${entity.id}.center`);
        }
        const fixedPin = [...pins].find((p) => isFixed(sketch, p));
        if (fixedPin) return fail(`${fixedPin} 은(는) 고정되어 있어 옮길 수 없습니다 (고정 구속을 먼저 지우세요)`);
        const next = { ...sketch, entities: sketch.entities.map((e) => (e.id === cmd.entity ? moved : e)) };
        return solvedResult(model, next, cmd, null, pins);
      }
      const users = extrudeUsers(model, sketch.id, cmd.entity);
      if (users.length) return fail(`${cmd.entity} 을(를) 쓰는 돌출이 있어 삭제할 수 없습니다: ${users.join(', ')}`);
      const regions = regionUsers(sketch, cmd.entity);
      if (regions.length) return fail(`${cmd.entity} 을(를) 쓰는 영역이 있어 삭제할 수 없습니다: ${regions.join(', ')} (영역에서 먼저 빼세요)`);
      const next = {
        ...sketch,
        entities: sketch.entities.filter((e) => e.id !== cmd.entity),
        dimensions: sketch.dimensions.filter((d) => d.entity !== cmd.entity),
        // 그 요소를 참조하던 구속도 함께 지운다
        constraints: sketch.constraints.filter((c) => !c.refs.some((ref) => refersTo(ref, cmd.entity))),
      };
      return ok(replaceSketch(model, next), cmd, sketch.id);
    }

    case 'set_sketch_plane': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const planeErr = planeError(model, cmd.plane);
      if (planeErr) return fail(planeErr);
      return okUnlessCycle(replaceSketch(model, { ...sketch, plane: cmd.plane }), cmd, null);
    }

    case 'add_polygon': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (sketch.entities.length >= LIMITS.maxSketchEntities) return fail(`스케치 요소는 최대 ${LIMITS.maxSketchEntities}개까지 가능합니다`);
      const id = cmd.id ?? nextEntityId(sketch, 'poly');
      if (sketch.entities.some((e) => e.id === id)) return fail(`스케치에 이미 있는 요소 ID입니다: ${id}`);
      const err = polygonError(cmd.points);
      if (err) return fail(err);
      const next: Sketch = { ...sketch, entities: [...sketch.entities, { id, type: 'polygon', points: cmd.points }] };
      return ok(replaceSketch(model, next), cmd, sketch.id);
    }

    case 'add_line':
    case 'add_slot': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (sketch.entities.length >= LIMITS.maxSketchEntities) return fail(`스케치 요소는 최대 ${LIMITS.maxSketchEntities}개까지 가능합니다`);
      const id = cmd.id ?? nextEntityId(sketch, cmd.type === 'add_line' ? 'line' : 'slot');
      if (sketch.entities.some((e) => e.id === id)) return fail(`스케치에 이미 있는 요소 ID입니다: ${id}`);
      if (cmd.type === 'add_line') {
        const [a, b] = cmd.points;
        if (Math.hypot(b[0] - a[0], b[1] - a[1]) < MIN_EDGE) return fail(`구성선이 너무 짧습니다 (${MIN_EDGE}mm 미만)`);
        return ok(replaceSketch(model, { ...sketch, entities: [...sketch.entities, { id, type: 'line', points: cmd.points }] }), cmd, sketch.id);
      }
      const next: Sketch = {
        ...sketch,
        entities: [...sketch.entities, { id, type: 'slot', center: cmd.center ?? [0, 0], angle: cmd.angle ?? 0 }],
        dimensions: [
          ...sketch.dimensions,
          { id: `${id}.length`, entity: id, kind: 'length', value: cmd.length },
          { id: `${id}.width`, entity: id, kind: 'width', value: cmd.width },
        ],
      };
      return ok(replaceSketch(model, next), cmd, sketch.id);
    }

    case 'set_entity_angle': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const e = sketch.entities.find((x) => x.id === cmd.entity);
      if (!e) return fail(`'${sketch.name}'에 요소 ${cmd.entity} 이(가) 없습니다`);
      if (e.type !== 'slot') return fail('방향(각도)은 슬롯에만 있습니다');
      return solvedResult(model, { ...sketch, entities: sketch.entities.map((x) => (x.id === e.id ? { ...e, angle: cmd.angle } : x)) }, cmd, null);
    }

    case 'helix': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const prof = resolveProfile(sketch, cmd.profile);
      if (!prof) return fail(`'${sketch.name}'에 쓸 수 있는 프로파일 ${cmd.profile} 이(가) 없습니다`);
      if (prof.type === 'region') return fail(REGION_UNSUPPORTED);
      const err = helixError(helixProfilePoints(prof, 0.05), cmd.pitch);
      if (err) return fail(err);
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'helix');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const obj: CadObject = {
        id,
        name: cmd.name ?? `헬릭스 ${model.objects.filter((o) => o.kind === 'helix').length + 1}`,
        kind: 'helix',
        params: { pitch: cmd.pitch, turns: cmd.turns },
        helix: { sketch: sketch.id, profile: cmd.profile },
        transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
      };
      return okUnlessCycle({ ...model, objects: [...model.objects, obj] }, cmd, id);
    }

    case 'loft': {
      for (const s of cmd.sections) {
        const sk = findSketch(model, s.sketch);
        if (!sk) return fail(`존재하지 않는 스케치입니다: ${s.sketch}`);
        const prof = resolveProfile(sk, s.profile);
        if (!prof) return fail(`'${sk.name}'에 쓸 수 있는 프로파일 ${s.profile} 이(가) 없습니다`);
        if (prof.type === 'region') return fail(REGION_UNSUPPORTED);
      }
      if (new Set(cmd.sections.map((s) => s.sketch)).size !== cmd.sections.length) return fail('로프트 단면은 서로 다른 스케치에 있어야 합니다');
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'loft');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const obj: CadObject = {
        id,
        name: cmd.name ?? `로프트 ${model.objects.filter((o) => o.kind === 'loft').length + 1}`,
        kind: 'loft',
        loft: { sections: cmd.sections },
        transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
      };
      return okUnlessCycle({ ...model, objects: [...model.objects, obj] }, cmd, id);
    }

    case 'add_path': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (sketch.entities.length >= LIMITS.maxSketchEntities) return fail(`스케치 요소는 최대 ${LIMITS.maxSketchEntities}개까지 가능합니다`);
      const id = cmd.id ?? nextEntityId(sketch, 'path');
      if (sketch.entities.some((e) => e.id === id)) return fail(`스케치에 이미 있는 요소 ID입니다: ${id}`);
      const err = openPathError(cmd.points);
      if (err) return fail(`경로: ${err}`);
      return ok(replaceSketch(model, { ...sketch, entities: [...sketch.entities, { id, type: 'path', points: cmd.points }] }), cmd, sketch.id);
    }

    case 'set_corner': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const e = sketch.entities.find((x) => x.id === cmd.entity);
      if (!e) return fail(`'${sketch.name}'에 요소 ${cmd.entity} 이(가) 없습니다`);
      if (e.type !== 'polygon' && e.type !== 'path') return fail('스케치 필렛·모따기는 다각형·경로의 꼭짓점에만 할 수 있습니다 (사각형은 다각형으로 그리세요)');
      const closed = e.type === 'polygon';
      const n = e.points.length;
      const all = Array.from({ length: n }, (_, k) => k).filter((k) => closed || (k > 0 && k < n - 1));
      const ks = cmd.vertices ?? all;
      const bad = ks.find((k) => !all.includes(k));
      if (bad !== undefined) return fail(`꼭짓점 p${bad} 에는 모서리 처리를 할 수 없습니다${closed ? ` (꼭짓점은 p0~p${n - 1})` : ' (경로는 양 끝점을 뺀 안쪽 꼭짓점만)'}`);
      if (!ks.length) return fail('처리할 꼭짓점이 없습니다 (경로에 꺾이는 점이 없습니다)');
      const kept = (e.corners ?? []).filter((c) => !ks.includes(c.k));
      const added: Corner[] = cmd.size > 0 ? ks.map((k) => ({ k, type: cmd.corner, size: cmd.size })) : [];
      const corners = [...kept, ...added].sort((a, b) => a.k - b.k);
      const err = cornerError(e.points, corners, closed, e.arcs, e.spline);
      if (err) return fail(err);
      const { corners: _old, ...rest } = e;
      void _old;
      const next = corners.length ? { ...rest, corners } : rest;
      return ok(replaceSketch(model, { ...sketch, entities: sketch.entities.map((x) => (x.id === e.id ? next : x)) }), cmd, sketch.id);
    }

    case 'set_arc': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const e = sketch.entities.find((x) => x.id === cmd.entity);
      if (!e) return fail(`'${sketch.name}'에 요소 ${cmd.entity} 이(가) 없습니다`);
      if (e.type !== 'polygon' && e.type !== 'path') return fail('호 변은 다각형·경로에만 있습니다 (사각형은 다각형으로 바꾸세요)');
      const closed = e.type === 'polygon';
      const edges = closed ? e.points.length : e.points.length - 1;
      if (cmd.edge >= edges) return fail(`변 e${cmd.edge} 이(가) 없습니다 (변은 e0~e${edges - 1})`);
      const arcs = [...(e.arcs ?? []).filter((a) => a.k !== cmd.edge), ...(Math.abs(cmd.bulge) > 1e-9 ? [{ k: cmd.edge, bulge: cmd.bulge }] : [])].sort((a, b) => a.k - b.k);
      const err = cornerError(e.points, e.corners, closed, arcs, e.spline);
      if (err) return fail(err);
      const { arcs: _old, ...rest } = e;
      void _old;
      const next = arcs.length ? { ...rest, arcs } : rest;
      return ok(replaceSketch(model, { ...sketch, entities: sketch.entities.map((x) => (x.id === e.id ? next : x)) }), cmd, sketch.id);
    }

    case 'set_spline': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const e = sketch.entities.find((x) => x.id === cmd.entity);
      if (!e || (e.type !== 'polygon' && e.type !== 'path')) return fail(`'${sketch.name}'에 다각형·경로 ${cmd.entity} 이(가) 없습니다 (스플라인은 다각형·경로에)`);
      // 켜면 꼭짓점 처리·호 변은 지운다 (곡선이 점들을 매끈하게 지나므로)
      const { corners: _c, arcs: _a, spline: _s, ...rest } = e;
      void _c;
      void _a;
      void _s;
      const next = cmd.spline ? { ...rest, spline: true as const } : { ...e, spline: undefined };
      if (!cmd.spline) delete (next as { spline?: true }).spline;
      return ok(replaceSketch(model, { ...sketch, entities: sketch.entities.map((x) => (x.id === e.id ? next : x)) }), cmd, sketch.id);
    }

    case 'add_region':
    case 'set_region': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      let id: string;
      if (cmd.type === 'add_region') {
        if (sketch.entities.length >= LIMITS.maxSketchEntities) return fail(`스케치 요소는 최대 ${LIMITS.maxSketchEntities}개까지 가능합니다`);
        id = cmd.id ?? nextEntityId(sketch, 'region');
        if (sketch.entities.some((e) => e.id === id)) return fail(`스케치에 이미 있는 요소 ID입니다: ${id}`);
      } else {
        const e = sketch.entities.find((x) => x.id === cmd.entity);
        if (!e || e.type !== 'region') return fail(`'${sketch.name}'에 영역 ${cmd.entity} 이(가) 없습니다`);
        id = e.id;
      }
      const err = regionError(sketch, cmd.items, id);
      if (err) return fail(err);
      const entity = { id, type: 'region' as const, items: cmd.items };
      const next: Sketch = {
        ...sketch,
        entities: cmd.type === 'add_region' ? [...sketch.entities, entity] : sketch.entities.map((x) => (x.id === id ? entity : x)),
      };
      return ok(replaceSketch(model, next), cmd, sketch.id);
    }

    case 'convert_to_polygon': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const e = sketch.entities.find((x) => x.id === cmd.entity);
      if (!e) return fail(`'${sketch.name}'에 요소 ${cmd.entity} 이(가) 없습니다`);
      if (e.type !== 'rectangle') return fail('사각형만 다각형으로 바꿀 수 있습니다');
      const prof = resolveProfile(sketch, e.id);
      if (!prof || prof.type !== 'rectangle') return fail(`${e.id} 의 치수가 완전하지 않습니다`);
      const [cx, cy] = prof.center;
      const [w, h] = [prof.width / 2, prof.height / 2];
      const round = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
      const points: [number, number][] = [[cx - w, cy - h], [cx + w, cy - h], [cx + w, cy + h], [cx - w, cy + h]].map(([x, y]) => [round(x!), round(y!)]);
      // 같은 ID 로 바꿔 넣는다 → 이 요소를 쓰는 돌출은 그대로. 중심을 참조하던 구속·치수는 지운다
      const next: Sketch = {
        ...sketch,
        entities: sketch.entities.map((x) => (x.id === e.id ? { id: e.id, type: 'polygon', points } : x)),
        dimensions: sketch.dimensions.filter((d) => d.entity !== e.id),
        constraints: sketch.constraints.filter((c) => !c.refs.some((r) => refersTo(r, e.id))),
      };
      return ok(replaceSketch(model, next), cmd, sketch.id);
    }

    case 'sweep': {
      const sketch = findSketch(model, cmd.sketch);
      const pathSketch = findSketch(model, cmd.pathSketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (!pathSketch) return fail(`존재하지 않는 스케치입니다: ${cmd.pathSketch}`);
      const prof = resolveProfile(sketch, cmd.profile);
      if (!prof) return fail(`'${sketch.name}'에 쓸 수 있는 단면 ${cmd.profile} 이(가) 없습니다`);
      if (prof.type === 'region') return fail(REGION_UNSUPPORTED);
      const path = openLinePoints(pathSketch, cmd.path);
      if (!path) return fail(`'${pathSketch.name}'에 경로(열린 선) ${cmd.path} 이(가) 없습니다`);
      const err = sweepError(sweepProfilePoints(prof, 0.05), path);
      if (err) return fail(err);
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'sweep');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const obj: CadObject = {
        id,
        name: cmd.name ?? `스윕 ${model.objects.filter((o) => o.kind === 'sweep').length + 1}`,
        kind: 'sweep',
        sweep: { sketch: sketch.id, profile: cmd.profile, pathSketch: pathSketch.id, path: cmd.path },
        transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
      };
      return okUnlessCycle({ ...model, objects: [...model.objects, obj] }, cmd, id);
    }

    case 'offset_entity': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const e = sketch.entities.find((x) => x.id === cmd.entity);
      if (!e) return fail(`'${sketch.name}'에 요소 ${cmd.entity} 이(가) 없습니다`);
      if (sketch.entities.length >= LIMITS.maxSketchEntities) return fail(`스케치 요소는 최대 ${LIMITS.maxSketchEntities}개까지 가능합니다`);
      if (Math.abs(cmd.distance) < MIN_EDGE) return fail(`오프셋 거리는 ${MIN_EDGE}mm 이상이어야 합니다`);
      const d = cmd.distance;
      const dim = (k: 'width' | 'height' | 'diameter' | 'length') => sketch.dimensions.find((x) => x.entity === e.id && x.kind === k)?.value ?? 0;
      const id = cmd.id ?? nextEntityId(sketch, e.type === 'rectangle' ? 'rect' : e.type);
      if (sketch.entities.some((x) => x.id === id)) return fail(`스케치에 이미 있는 요소 ID입니다: ${id}`);
      const tooSmall = () => fail('안쪽 오프셋이 너무 커서 모양이 사라집니다');
      let entity: Sketch['entities'][number];
      let dims: Sketch['dimensions'] = [];
      if (e.type === 'rectangle') {
        const [w, h] = [dim('width') + 2 * d, dim('height') + 2 * d];
        if (w < LIMITS.minDimension || h < LIMITS.minDimension) return tooSmall();
        entity = { id, type: 'rectangle', center: e.center };
        dims = [{ id: `${id}.width`, entity: id, kind: 'width', value: w }, { id: `${id}.height`, entity: id, kind: 'height', value: h }];
      } else if (e.type === 'circle') {
        const dia = dim('diameter') + 2 * d;
        if (dia < LIMITS.minDimension) return tooSmall();
        entity = { id, type: 'circle', center: e.center };
        dims = [{ id: `${id}.diameter`, entity: id, kind: 'diameter', value: dia }];
      } else if (e.type === 'slot') {
        const w = dim('width') + 2 * d;
        if (w < LIMITS.minDimension) return tooSmall();
        entity = { id, type: 'slot', center: e.center, angle: e.angle };
        dims = [{ id: `${id}.length`, entity: id, kind: 'length', value: dim('length') }, { id: `${id}.width`, entity: id, kind: 'width', value: w }];
      } else if (e.type === 'polygon') {
        const pts = offsetPolygon(e.points, d);
        const err = pts ? polygonError(pts) : '안쪽 오프셋이 너무 큽니다';
        if (!pts || err) return fail(`오프셋 결과: ${err}`);
        // 꼭짓점 처리는 같은 크기로 옮긴다 (들어가지 않으면 뺀다)
        // 스플라인은 점을 띄운 근사 (곡선 자체의 정확한 오프셋은 아님)
        entity = { id, type: 'polygon', points: pts, ...(e.corners?.length && !cornerError(pts, e.corners, true) ? { corners: e.corners } : {}), ...(e.spline ? { spline: true as const } : {}) };
      } else return fail('구성선·경로·영역은 오프셋할 수 없습니다');
      return ok(replaceSketch(model, { ...sketch, entities: [...sketch.entities, entity], dimensions: [...sketch.dimensions, ...dims] }), cmd, sketch.id);
    }

    case 'move_point': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (refKind(sketch, cmd.point) !== 'point') return fail(`점이 아닙니다: ${cmd.point} (꼭짓점 "poly1.p0" 또는 중심 "c1.center")`);
      if (isFixed(sketch, cmd.point)) return fail(`${cmd.point} 은(는) 고정되어 있어 옮길 수 없습니다 (고정 구속을 먼저 지우세요)`);
      const [id, part] = cmd.point.split('.') as [string, string];
      const entities = sketch.entities.map((e) => {
        if (e.id !== id) return e;
        if (e.type === 'polygon' || e.type === 'path') return { ...e, points: e.points.map((p, k) => (`p${k}` === part ? cmd.to : p)) };
        if (e.type === 'line') return { ...e, points: e.points.map((p, k) => (`p${k}` === part ? cmd.to : p)) as [[number, number], [number, number]] };
        return { ...e, center: cmd.to };
      });
      return solvedResult(model, { ...sketch, entities }, cmd, null, new Set([cmd.point]));
    }

    case 'add_constraint': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (sketch.constraints.length >= LIMITS.maxSketchConstraints) return fail(`구속은 최대 ${LIMITS.maxSketchConstraints}개까지 가능합니다`);
      let n = 1;
      while (sketch.constraints.some((c) => c.id === `k${n}`)) n++;
      const id = cmd.id ?? `k${n}`;
      if (sketch.constraints.some((c) => c.id === id)) return fail(`이미 있는 구속 ID입니다: ${id}`);
      const constraint = { id, type: cmd.constraint, refs: cmd.refs, ...(cmd.value !== undefined ? { value: cmd.value } : {}) };
      const err = constraintError(sketch, constraint);
      if (err) return fail(err);
      if (cmd.constraint === 'fix' && isFixed(sketch, cmd.refs[0]!)) return fail(`${cmd.refs[0]} 은(는) 이미 고정되어 있습니다`);
      const r = solvedResult(model, { ...sketch, constraints: [...sketch.constraints, constraint] }, cmd, null);
      return r.ok ? r : fail(`${CONSTRAINT_LABEL[cmd.constraint]} 구속을 추가할 수 없습니다: ${r.error}`);
    }

    case 'set_constraint': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const c = sketch.constraints.find((x) => x.id === cmd.constraint);
      if (!c) return fail(`'${sketch.name}'에 구속 ${cmd.constraint} 이(가) 없습니다`);
      if (c.value === undefined) return fail(`${CONSTRAINT_LABEL[c.type]} 구속에는 값이 없습니다`);
      const next = { ...sketch, constraints: sketch.constraints.map((x) => (x.id === c.id ? { ...x, value: cmd.value } : x)) };
      return solvedResult(model, next, cmd, null);
    }

    case 'delete_constraint': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (!sketch.constraints.some((x) => x.id === cmd.constraint)) return fail(`'${sketch.name}'에 구속 ${cmd.constraint} 이(가) 없습니다`);
      return ok(replaceSketch(model, { ...sketch, constraints: sketch.constraints.filter((x) => x.id !== cmd.constraint) }), cmd, null);
    }

    case 'rename_sketch': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      return ok(replaceSketch(model, { ...sketch, name: cmd.name }), cmd, sketch.id);
    }

    case 'delete_sketch': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      const users = extrudeUsers(model, sketch.id);
      if (users.length) return fail(`'${sketch.name}'을(를) 쓰는 돌출이 있어 삭제할 수 없습니다: ${users.join(', ')}`);
      return ok({ ...model, sketches: model.sketches.filter((s) => s.id !== sketch.id) }, cmd, null);
    }

    case 'extrude': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (!sketch.entities.some((e) => e.id === cmd.profile)) {
        const names = sketch.entities.map((e) => e.id).join(', ') || '없음';
        return fail(`'${sketch.name}'에 프로파일 ${cmd.profile} 이(가) 없습니다 (있는 요소: ${names})`);
      }
      if (cmd.thin !== undefined) {
        // 얇은 돌출·리브: 열린 선을 두께만큼 띄운 단면
        if (!openLinePoints(sketch, cmd.profile)) return fail(`리브(얇은 돌출)는 열린 선(구성선·경로)에만 쓸 수 있습니다: ${cmd.profile}`);
        const prof = profileOf(sketch, { profile: cmd.profile, thin: cmd.thin });
        const err = prof?.type === 'polygon' ? polygonError(prof.points) : null;
        if (err) return fail(`리브 단면: ${err} (두께를 줄이거나 선의 꺾임을 완만하게 하세요)`);
      } else if (!resolveProfile(sketch, cmd.profile)) {
        if (openLinePoints(sketch, cmd.profile)) return fail(`${cmd.profile} 은(는) 열린 선입니다. 두께(thin)를 주면 리브로 돌출됩니다`);
        return fail(`프로파일 ${cmd.profile} 의 치수가 완전하지 않습니다`);
      }
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'extrude');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const obj: CadObject = {
        id,
        name: cmd.name ?? (cmd.thin !== undefined ? `리브 ${model.objects.filter((o) => o.kind === 'extrude' && o.extrude.thin !== undefined).length + 1}` : `돌출 ${model.objects.filter((o) => o.kind === 'extrude').length + 1}`),
        kind: 'extrude',
        params: { distance: cmd.distance },
        extrude: { sketch: sketch.id, profile: cmd.profile, ...(cmd.thin !== undefined ? { thin: cmd.thin } : {}) },
        transform: { position: cmd.position ?? [0, 0, 0], rotation: [0, 0, 0] },
      };
      return ok({ ...model, objects: [...model.objects, obj] }, cmd, id);
    }

    case 'revolve': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      if (!sketch.entities.some((e) => e.id === cmd.profile)) {
        const names = sketch.entities.map((e) => e.id).join(', ') || '없음';
        return fail(`'${sketch.name}'에 프로파일 ${cmd.profile} 이(가) 없습니다 (있는 요소: ${names})`);
      }
      const prof = resolveProfile(sketch, cmd.profile);
      if (!prof) return fail(`프로파일 ${cmd.profile} 의 치수가 완전하지 않습니다`);
      const axisErr = revolveProfileError(prof);
      if (axisErr) return fail(axisErr);
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'revolve');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const obj: CadObject = {
        id,
        name: cmd.name ?? `회전 ${model.objects.filter((o) => o.kind === 'revolve').length + 1}`,
        kind: 'revolve',
        params: { angle: cmd.angle ?? 360 },
        revolve: { sketch: sketch.id, profile: cmd.profile },
        transform: { position: cmd.position ?? [0, 0, 0], rotation: [0, 0, 0] },
      };
      return ok({ ...model, objects: [...model.objects, obj] }, cmd, id);
    }
  }
}

/**
 * 다각형 오프셋 (모서리는 변을 연장해 만나게 = 마이터). d > 0 바깥, d < 0 안쪽. 꼭짓점 수는 그대로.
 * 변이 사라질 만큼 안쪽이면(방향이 뒤집힘) null
 */
export function offsetPolygon(points: [number, number][], d: number): [number, number][] | null {
  const n = points.length;
  const ccw = points.reduce((a, p, i) => a + p[0] * points[(i + 1) % n]![1] - points[(i + 1) % n]![0] * p[1], 0) > 0;
  const s = ccw ? 1 : -1; // 반시계면 바깥 법선 = 변 방향을 시계로 90°
  const lines = points.map((a, i) => {
    const b = points[(i + 1) % n]!;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    const nx = (s * (b[1] - a[1])) / len;
    const ny = (s * -(b[0] - a[0])) / len;
    return { p: [a[0] + nx * d, a[1] + ny * d], dir: [(b[0] - a[0]) / len, (b[1] - a[1]) / len] };
  });
  const out: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const l1 = lines[(i - 1 + n) % n]!;
    const l2 = lines[i]!;
    const den = l1.dir[0]! * l2.dir[1]! - l1.dir[1]! * l2.dir[0]!;
    if (Math.abs(den) < 1e-9) out.push([l2.p[0]!, l2.p[1]!]);
    else {
      const t = ((l2.p[0]! - l1.p[0]!) * l2.dir[1]! - (l2.p[1]! - l1.p[1]!) * l2.dir[0]!) / den;
      out.push([Math.round((l1.p[0]! + t * l1.dir[0]!) * 1e6) / 1e6, Math.round((l1.p[1]! + t * l1.dir[1]!) * 1e6) / 1e6]);
    }
  }
  // 변 방향이 원래와 반대가 되면(안쪽으로 너무 줄임) 실패
  for (let i = 0; i < n; i++) {
    const a = points[i]!, b = points[(i + 1) % n]!, c = out[i]!, e = out[(i + 1) % n]!;
    if ((b[0] - a[0]) * (e[0] - c[0]) + (b[1] - a[1]) * (e[1] - c[1]) <= 0) return null;
  }
  return out;
}
