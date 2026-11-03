/**
 * CAD 명령 실행기 (순수 함수).
 *
 * AI가 만든 명령과 사용자가 UI로 만든 명령은 모두 이 함수를 통과한다.
 * - 입력은 unknown 으로 받아 스키마 검증부터 한다 (AI 출력은 신뢰하지 않는다).
 * - 존재하지 않는 객체 참조, 중복 ID 등은 실행 전에 거부한다.
 * - 실패하면 원본 모델을 그대로 두고 에러만 반환한다 (이전 정상 상태 유지).
 *
 * 실제 형상 계산은 백엔드 CadQuery 가 담당하고, 이 실행기는 ModelDefinition(설계 원본) 갱신만 책임진다.
 *
 * 불리언 트리 규칙
 * - cut/union/intersect 는 피연산자를 자식으로 갖는 불리언 객체를 만든다. 피연산자는 최상위 객체여야 한다.
 * - 불리언의 좌표계 = 기준(base) 객체의 변환. 자식 변환은 부모 기준으로 변환해 저장한다.
 * - 자식의 translate/set_transform 은 부모 좌표계 기준이다.
 * - 불리언을 삭제하면 하위 객체 전체가 삭제된다. 자식만 단독 삭제하는 것은 거부한다.
 */
import {
  CadCommandSchema,
  PARAMS_SCHEMAS,
  type BooleanCommand,
  type CadCommand,
  type CadObject,
  type CreateCommand,
  type ModelDefinition,
  type ObjectId,
  type PrimitiveKind,
  type Transform,
  type Vec3,
  LIMITS,
} from './commandTypes';
import { KIND_INFO, OPERATION_INFO } from './objectKinds';
import { byId, depthOf, parentMap, subtreeIds } from './modelGraph';
import { IDENTITY, relativeTransform } from './transformMath';
import { edgeFeatureError } from './edgeFeature';
import { executeSketchCommand, isSketchCommand } from './sketchCommands';

export type ExecuteResult =
  | { ok: true; model: ModelDefinition; command: CadCommand; affectedId: ObjectId | null }
  | { ok: false; error: string };

export function executeCommand(model: ModelDefinition, input: unknown): ExecuteResult {
  const parsed = CadCommandSchema.safeParse(input);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? ` (${issue.path.join('.')})` : '';
    return { ok: false, error: `잘못된 명령${where}: ${issue?.message ?? '알 수 없는 오류'}` };
  }
  const cmd = parsed.data;

  if (isSketchCommand(cmd)) return executeSketchCommand(model, cmd);

  switch (cmd.type) {
    case 'create_box':
      return create(model, cmd, 'box', { width: cmd.width, depth: cmd.depth, height: cmd.height });
    case 'create_cylinder':
      return create(model, cmd, 'cylinder', { radius: cmd.radius, height: cmd.height });
    case 'create_sphere':
      return create(model, cmd, 'sphere', { radius: cmd.radius });
    case 'create_cone':
      return create(model, cmd, 'cone', {
        radiusBottom: cmd.radiusBottom,
        radiusTop: cmd.radiusTop,
        height: cmd.height,
      });

    case 'cut':
    case 'union':
    case 'intersect':
      return createBoolean(model, cmd);

    case 'set_params': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind === 'boolean') {
        return fail(`${OPERATION_INFO[target.boolean.operation].label} 결과에는 치수 파라미터가 없습니다. 포함된 객체의 치수를 바꾸세요`);
      }
      const allowed = new Set(KIND_INFO[target.kind].params.map((p) => p.key));
      const invalid = Object.keys(cmd.params).filter((k) => !allowed.has(k));
      if (invalid.length > 0) {
        return fail(
          `${KIND_INFO[target.kind].label}에는 ${invalid.join(', ')} 파라미터가 없습니다 ` +
            `(사용 가능: ${[...allowed].join(', ')})`,
        );
      }
      const merged = buildObject(target.kind, {
        ...target,
        params: { ...target.params, ...cmd.params },
      });
      if (!merged.ok) return merged;
      // 박스를 줄여 기존 모서리 처리가 들어가지 않게 되면 거부
      if (merged.object.kind === 'box' && target.kind === 'box' && target.edgeFeature) {
        const err = edgeFeatureError(merged.object.params, target.edgeFeature);
        if (err) return fail(`${err}. 모서리 처리를 먼저 줄이세요`);
        merged.object.edgeFeature = target.edgeFeature;
      }
      return done(model, replaceObject(model, merged.object), cmd, target.id);
    }

    case 'fillet':
    case 'chamfer': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'box') return fail('모서리 처리(필렛·모따기)는 현재 박스에만 할 수 있습니다');
      const size = cmd.type === 'fillet' ? cmd.radius : cmd.distance;
      if (size === 0) {
        const { edgeFeature: _removed, ...rest } = target;
        void _removed;
        return done(model, replaceObject(model, rest), cmd, target.id);
      }
      if (size < LIMITS.minDimension) return fail(`크기는 ${LIMITS.minDimension}mm 이상이어야 합니다 (0 은 제거)`);
      const feature = { type: cmd.type, size, edges: cmd.edges ?? 'all' } as const;
      const err = edgeFeatureError(target.params, feature);
      if (err) return fail(err);
      return done(model, replaceObject(model, { ...target, edgeFeature: feature }), cmd, target.id);
    }

    case 'translate': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      const position = addVec(target.transform.position, cmd.offset);
      if (!withinBounds(position)) return fail('이동 결과가 허용 작업 영역을 벗어납니다');
      // 불리언의 자식이면 offset 은 부모 좌표계 기준이다
      return done(
        model,
        replaceObject(model, { ...target, transform: { ...target.transform, position } }),
        cmd,
        target.id,
      );
    }

    case 'set_transform': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      return done(
        model,
        replaceObject(model, {
          ...target,
          transform: {
            position: cmd.position ?? target.transform.position,
            rotation: cmd.rotation ?? target.transform.rotation,
          },
        }),
        cmd,
        target.id,
      );
    }

    case 'rename_object': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      return done(model, replaceObject(model, { ...target, name: cmd.name }), cmd, target.id);
    }

    case 'duplicate_object': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      const parent = parentMap(model).get(target.id);
      if (parent) return fail(`'${target.name}'은(는) 불리언에 포함되어 있어 복제할 수 없습니다. 상위 객체를 복제하세요`);
      const ids = subtreeIds(model, target.id);
      if (model.objects.length + ids.length > LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      if (cmd.newId && idTaken(model, cmd.newId)) return fail(`이미 존재하는 ID입니다: ${cmd.newId}`);
      const position = addVec(target.transform.position, cmd.offset ?? [10, 10, 0]);
      if (!withinBounds(position)) return fail('복제 위치가 허용 작업 영역을 벗어납니다');

      // 하위 객체부터 새 ID 를 발급하며 복제 (자식 → 부모 순서이므로 참조를 바로 바꿀 수 있다)
      const index = byId(model);
      const idMap = new Map<ObjectId, ObjectId>();
      let working = model;
      const copies: CadObject[] = [];
      for (const oldId of ids) {
        const src = index.get(oldId)!;
        const isRoot = oldId === target.id;
        const newId = isRoot && cmd.newId ? cmd.newId : nextId(working, idPrefix(src));
        idMap.set(oldId, newId);
        const copy: CadObject = structuredClone(src);
        copy.id = newId;
        if (copy.kind === 'boolean') {
          copy.boolean = {
            ...copy.boolean,
            base: idMap.get(copy.boolean.base)!,
            tools: copy.boolean.tools.map((t) => idMap.get(t)!),
          };
        }
        if (isRoot) {
          copy.name = `${src.name} 복사본`;
          copy.transform = { ...src.transform, position };
        }
        copies.push(copy);
        working = { ...working, objects: [...working.objects, copy] };
      }
      return done(model, { ...model, objects: [...model.objects, ...copies] }, cmd, idMap.get(target.id)!);
    }

    case 'delete_object': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      const parentId = parentMap(model).get(target.id);
      if (parentId) {
        const parent = findObject(model, parentId)!;
        return fail(`'${target.name}'은(는) '${parent.name}'에 포함되어 있어 단독으로 삭제할 수 없습니다`);
      }
      const remove = new Set(subtreeIds(model, target.id));
      // 면 위 스케치가 붙어 있으면 거부 (스케치를 다른 평면으로 옮기거나 지운 뒤 삭제)
      const anchored = model.sketches.filter((k) => k.plane.type === 'face' && remove.has(k.plane.object));
      if (anchored.length)
        return fail(`'${anchored.map((k) => k.name).join("', '")}' 스케치가 이 객체의 면에 붙어 있어 삭제할 수 없습니다`);
      return done(model, { ...model, objects: model.objects.filter((o) => !remove.has(o.id)) }, cmd, null);
    }
  }
}

export type BatchResult =
  | { ok: true; model: ModelDefinition; commands: CadCommand[]; affectedId: ObjectId | null }
  | { ok: false; error: string; index: number };

/**
 * 명령 목록을 순서대로 실행한다. 하나라도 실패하면 전체를 적용하지 않는다 (원자적).
 * AI 요청 1건 = 일괄 실행 1번 = 실행 취소 1단계.
 */
export function executeBatch(model: ModelDefinition, inputs: unknown[]): BatchResult {
  if (inputs.length === 0) return { ok: false, error: '실행할 명령이 없습니다', index: 0 };
  let current = model;
  const commands: CadCommand[] = [];
  let affectedId: ObjectId | null = null;
  for (let i = 0; i < inputs.length; i++) {
    const r = executeCommand(current, inputs[i]);
    if (!r.ok) return { ok: false, error: `${i + 1}번째 명령: ${r.error}`, index: i };
    current = r.model;
    commands.push(r.command);
    affectedId = r.affectedId ?? affectedId;
  }
  return { ok: true, model: current, commands, affectedId };
}

// ---- helpers --------------------------------------------------------------

function create(
  model: ModelDefinition,
  cmd: CreateCommand,
  kind: PrimitiveKind,
  params: Record<string, number>,
): ExecuteResult {
  if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
  const id = cmd.id ?? nextId(model, kind);
  if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
  const built = buildObject(kind, {
    id,
    name: cmd.name ?? `${KIND_INFO[kind].label} ${countKind(model, kind) + 1}`,
    params,
    transform: { position: cmd.position ?? [0, 0, 0], rotation: [0, 0, 0] },
  });
  if (!built.ok) return built;
  return done(model, { ...model, objects: [...model.objects, built.object] }, cmd, id);
}

function createBoolean(model: ModelDefinition, cmd: BooleanCommand): ExecuteResult {
  const label = OPERATION_INFO[cmd.type].label;
  const operandIds = [cmd.base, ...cmd.tools];
  if (new Set(operandIds).size !== operandIds.length) return fail(`${label}: 같은 객체를 두 번 사용할 수 없습니다`);
  if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);

  const parents = parentMap(model);
  const operands: CadObject[] = [];
  for (const id of operandIds) {
    const o = findObject(model, id);
    if (!o) return missing(id);
    if (parents.has(id)) {
      return fail(`'${o.name}'은(는) 이미 다른 불리언에 포함되어 있습니다`);
    }
    operands.push(o);
  }

  const id = cmd.id ?? nextId(model, cmd.type);
  if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);

  const index = byId(model);
  const depth = 1 + Math.max(...operandIds.map((o) => depthOf(model, o, index)));
  if (depth > LIMITS.maxBooleanDepth) return fail(`불리언 중첩은 최대 ${LIMITS.maxBooleanDepth}단계까지 가능합니다`);

  // 새 불리언의 좌표계 = 기준 객체의 (월드) 변환. 피연산자는 그 좌표계 기준으로 다시 표현한다.
  const frame: Transform = operands[0]!.transform;
  const localized = new Map<ObjectId, CadObject>();
  for (const o of operands) {
    const t = o.id === cmd.base ? IDENTITY : relativeTransform(frame, o.transform);
    if (!withinBounds(t.position)) return fail('피연산자 위치가 허용 범위를 벗어납니다');
    localized.set(o.id, { ...o, transform: t });
  }

  const booleanObj: CadObject = {
    id,
    name: cmd.name ?? `${label} ${model.objects.filter((o) => o.kind === 'boolean' && o.boolean.operation === cmd.type).length + 1}`,
    kind: 'boolean',
    boolean: { operation: cmd.type, base: cmd.base, tools: cmd.tools },
    transform: frame,
  };
  const objects = [...model.objects.map((o) => localized.get(o.id) ?? o), booleanObj];
  return done(model, { ...model, objects }, cmd, id);
}

/** 자동 ID 접두사: 기본 도형은 종류, 불리언은 연산 이름 (예: box_1, cut_1) */
function idPrefix(o: CadObject): string {
  return o.kind === 'boolean' ? o.boolean.operation : o.kind;
}

/** 종류별 파라미터 스키마로 최종 객체를 검증한다 (교차 필드 규칙 포함, 예: 원뿔 반지름). */
function buildObject(
  kind: PrimitiveKind,
  fields: { id: ObjectId; name: string; transform: Transform; params: Record<string, number> },
): { ok: true; object: CadObject } | { ok: false; error: string } {
  const parsed = PARAMS_SCHEMAS[kind].safeParse(fields.params);
  if (!parsed.success) {
    return { ok: false, error: `잘못된 파라미터: ${parsed.error.issues[0]?.message ?? '알 수 없는 오류'}` };
  }
  return { ok: true, object: { ...fields, kind, params: parsed.data } as CadObject };
}

/** 객체·스케치 ID 는 한 이름 공간을 쓴다 (AI·사용자가 ID 하나로 무엇을 가리키는지 분명하도록) */
export function idTaken(model: ModelDefinition, id: ObjectId): boolean {
  return model.objects.some((o) => o.id === id) || model.sketches.some((s) => s.id === id);
}

export function findObject(model: ModelDefinition, id: ObjectId): CadObject | undefined {
  return model.objects.find((o) => o.id === id);
}

function replaceObject(model: ModelDefinition, obj: CadObject): ModelDefinition {
  return { ...model, objects: model.objects.map((o) => (o.id === obj.id ? obj : o)) };
}

function countKind(model: ModelDefinition, kind: PrimitiveKind): number {
  return model.objects.filter((o) => o.kind === kind).length;
}

/** `${kind}_${n}` 형식에서 사용되지 않은 다음 번호 (객체·스케치 ID 를 모두 피한다) */
export function nextId(model: ModelDefinition, kind: string): ObjectId {
  const re = new RegExp(`^${kind}_(\\d+)$`);
  let max = 0;
  for (const o of [...model.objects, ...model.sketches]) {
    const m = re.exec(o.id);
    if (m?.[1]) max = Math.max(max, Number(m[1]));
  }
  return `${kind}_${max + 1}`;
}

function addVec(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function withinBounds(v: Vec3): boolean {
  return v.every((c) => Math.abs(c) <= LIMITS.maxCoordinate);
}

function fail(error: string): ExecuteResult {
  return { ok: false, error };
}

function missing(id: string): ExecuteResult {
  return fail(`존재하지 않는 객체입니다: ${id}`);
}

function done(
  _before: ModelDefinition,
  after: ModelDefinition,
  command: CadCommand,
  affectedId: ObjectId | null,
): ExecuteResult {
  return { ok: true, model: after, command, affectedId };
}
