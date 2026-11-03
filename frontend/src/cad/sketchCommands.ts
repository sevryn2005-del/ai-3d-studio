/**
 * 스케치·돌출 명령 실행 (commandExecutor 에서 위임). 순수 함수, 실패 시 원본 그대로.
 */
import type { CadCommand, CadObject, ModelDefinition, ObjectId, Sketch } from './commandTypes';
import { LIMITS } from './commandTypes';
import { idTaken, nextId, type ExecuteResult } from './commandExecutor';
import { findSketch, resolveProfile } from './sketch';

const SKETCH_TYPES = [
  'create_sketch', 'add_rectangle', 'add_circle', 'set_dimension',
  'set_entity_center', 'delete_sketch_entity', 'set_sketch_plane', 'rename_sketch', 'delete_sketch', 'extrude',
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

function nextEntityId(sketch: Sketch, prefix: string): ObjectId {
  let n = 1;
  while (sketch.entities.some((e) => e.id === `${prefix}${n}`)) n++;
  return `${prefix}${n}`;
}

/** 스케치(또는 그 요소)를 참조하는 돌출 객체 이름 */
function extrudeUsers(model: ModelDefinition, sketchId: ObjectId, entityId?: ObjectId): string[] {
  return model.objects
    .filter((o) => o.kind === 'extrude' && o.extrude.sketch === sketchId && (entityId === undefined || o.extrude.profile === entityId))
    .map((o) => o.name);
}

export function executeSketchCommand(model: ModelDefinition, cmd: SketchCommand): ExecuteResult {
  switch (cmd.type) {
    case 'create_sketch': {
      if (model.sketches.length >= LIMITS.maxSketches) return fail(`스케치는 최대 ${LIMITS.maxSketches}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'sketch');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const sketch: Sketch = {
        id,
        name: cmd.name ?? `스케치 ${model.sketches.length + 1}`,
        plane: cmd.plane ?? { type: 'XY', offset: 0 },
        entities: [],
        dimensions: [],
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
      // 선택을 바꾸지 않는다 (돌출 객체를 보며 치수를 고치는 흐름)
      return ok(replaceSketch(model, next), cmd, null);
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
        const next = { ...sketch, entities: sketch.entities.map((e) => (e.id === cmd.entity ? { ...e, center: cmd.center } : e)) };
        return ok(replaceSketch(model, next), cmd, null);
      }
      const users = extrudeUsers(model, sketch.id, cmd.entity);
      if (users.length) return fail(`${cmd.entity} 을(를) 쓰는 돌출이 있어 삭제할 수 없습니다: ${users.join(', ')}`);
      const next = {
        ...sketch,
        entities: sketch.entities.filter((e) => e.id !== cmd.entity),
        dimensions: sketch.dimensions.filter((d) => d.entity !== cmd.entity),
      };
      return ok(replaceSketch(model, next), cmd, sketch.id);
    }

    case 'set_sketch_plane': {
      const sketch = findSketch(model, cmd.sketch);
      if (!sketch) return fail(`존재하지 않는 스케치입니다: ${cmd.sketch}`);
      return ok(replaceSketch(model, { ...sketch, plane: cmd.plane }), cmd, null);
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
      if (!resolveProfile(sketch, cmd.profile)) return fail(`프로파일 ${cmd.profile} 의 치수가 완전하지 않습니다`);
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'extrude');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const obj: CadObject = {
        id,
        name: cmd.name ?? `돌출 ${model.objects.filter((o) => o.kind === 'extrude').length + 1}`,
        kind: 'extrude',
        params: { distance: cmd.distance },
        extrude: { sketch: sketch.id, profile: cmd.profile },
        transform: { position: cmd.position ?? [0, 0, 0], rotation: [0, 0, 0] },
      };
      return ok({ ...model, objects: [...model.objects, obj] }, cmd, id);
    }
  }
}
