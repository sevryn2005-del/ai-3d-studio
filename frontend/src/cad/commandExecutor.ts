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
  type Mate,
  type Sketch,
  MAX_MATES,
  MAX_EXTRA_SHEETS,
  type ModelDefinition,
  type ObjectId,
  type PrimitiveKind,
  type Shell,
  type Transform,
  type Vec3,
  LIMITS,
  MAX_POLY_FACES,
  MAX_POLY_VERTS,
  type MeshEdit,
} from './commandTypes';
import { KIND_INFO, OPERATION_INFO, PATTERN_LABEL } from './objectKinds';
import { byId, depthOf, parentMap, subtreeIds, topLevelObjects, validateGraph, wrapperSource } from './modelGraph';
import { mateError, pruneMates, refObject, solveMates } from './mates';
import { IDENTITY, composeTransform, fromMatrix, relativeTransform, toMatrix } from './transformMath';
import { Matrix4 } from 'three';
import { patternError, shellError } from './features';
import { meshError } from './meshData';
import {
  type MeshPrimitive,
  type PolyMesh,
  type V3,
  deleteElements,
  edges,
  extrudeFaces,
  fillFace,
  insetFaces,
  loopCut,
  mergeVerts,
  polyMeshError,
  primitiveMesh,
  subdivideFaces,
  transformVerts,
} from './polymesh';
import { bevelEdges, bisectFaces } from './polymeshSelect';
import { voxelRemesh } from './remesh';
import { MAX_EVALUATED_FACES, estimateFaces, evaluateModifiers } from './polymeshModifiers';
import { helixError, helixProfilePoints } from './sections';
import { profileOf, resolveProfile } from './sketch';
import { polygonError } from './solver';
import { facesOf, faceLocalMatrix } from './sketchPlane';
import { edgeFeatureError } from './edgeFeature';
import { executeSketchCommand, isSketchCommand } from './sketchCommands';

type PatternCommand = Extract<CadCommand, { type: 'pattern' }>;
type HoleCommand = Extract<CadCommand, { type: 'hole' }>;

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
  const r = executeOne(model, cmd);
  if (!r.ok || !r.model.mates?.length || MATE_COMMANDS.has(cmd.type) || r.model === model) return r;
  // 조립 메이트 (형식 v11): 모델이 바뀌면 부품 위치를 다시 푼다. 사용자가 옮긴 부품은 그 자리에 두고 나머지가 따라온다
  const pinned = new Set<ObjectId>(cmd.type === 'translate' || cmd.type === 'set_transform' ? [cmd.target] : []);
  const solved = solveMates(pruneMates(r.model), pinned);
  if (!solved.ok) return fail(`메이트 때문에 할 수 없습니다: ${solved.error}`);
  return { ...r, model: solved.model };
}

const MATE_COMMANDS = new Set<CadCommand['type']>(['add_mate', 'set_mate', 'delete_mate']);

function executeOne(model: ModelDefinition, cmd: CadCommand): ExecuteResult {
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
      if (target.kind === 'pattern') return fail('패턴 값은 set_pattern 으로 바꿉니다');
      if (!('params' in target)) return fail(`${KIND_INFO[target.kind].label}에는 치수 파라미터가 없습니다`);
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
      if (merged.object.kind === 'helix') {
        const sk = model.sketches.find((s) => s.id === (merged.object as { helix: { sketch: string } }).helix.sketch);
        const prof = sk ? resolveProfile(sk, merged.object.helix.profile) : null;
        const err = prof && prof.type !== 'region' ? helixError(helixProfilePoints(prof, 0.05), merged.object.params.pitch) : null;
        if (err) return fail(err);
      }
      // 공통 선택 필드(억제·숨김·색)와 쉘은 그대로 유지. 줄여서 쉘이 들어가지 않으면 거부
      const kept = { ...merged.object, ...keepCommon(target) } as CadObject;
      if ('shell' in target && target.shell) {
        const err = shellError(kept, target.shell, model);
        if (err) return fail(`${err}. 쉘 두께를 먼저 줄이세요`);
        (kept as { shell?: Shell }).shell = target.shell;
      }
      return done(model, replaceObject(model, kept), cmd, target.id);
    }

    case 'fillet':
    case 'chamfer': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'box') return fail('모서리 처리(필렛·모따기)는 현재 박스에만 할 수 있습니다');
      if (target.shell && (cmd.type === 'fillet' ? cmd.radius : cmd.distance) > 0)
        return fail('쉘을 한 박스에는 아직 모서리 처리를 할 수 없습니다');
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
        if (copy.kind === 'pattern') copy.pattern = { ...copy.pattern, source: idMap.get(copy.pattern.source)! };
        if (copy.kind === 'fillet') copy.fillet = { ...copy.fillet, source: idMap.get(copy.fillet.source)! };
        if (copy.kind === 'draft') copy.draft = { ...copy.draft, source: idMap.get(copy.draft.source)! };
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
      // 패턴을 지우면 원본은 남긴다 (솔리드웍스와 같음): 원본을 최상위로, 위치는 월드 기준으로 되돌린다
      const wrapped = wrapperSource(target);
      if (wrapped) {
        const objects = model.objects
          .filter((o) => o.id !== target.id)
          .map((o) => (o.id === wrapped ? { ...o, transform: composeTransform(target.transform, o.transform) } : o));
        return done(model, { ...model, objects }, cmd, wrapped);
      }
      const remove = new Set(subtreeIds(model, target.id));
      // 면 위 스케치가 붙어 있으면 거부 (스케치를 다른 평면으로 옮기거나 지운 뒤 삭제)
      const anchored = model.sketches.filter((k) => k.plane.type === 'face' && remove.has(k.plane.object));
      if (anchored.length)
        return fail(`'${anchored.map((k) => k.name).join("', '")}' 스케치가 이 객체의 면에 붙어 있어 삭제할 수 없습니다`);
      return done(model, { ...model, objects: model.objects.filter((o) => !remove.has(o.id)) }, cmd, null);
    }

    case 'set_suppressed': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      const { suppressed: _s, ...rest } = target;
      void _s;
      return done(model, replaceObject(model, (cmd.suppressed ? { ...rest, suppressed: true } : rest) as CadObject), cmd, target.id);
    }

    case 'set_appearance': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      const next: Record<string, unknown> = { ...target };
      if (cmd.color === 'default') delete next.color;
      else if (cmd.color) next.color = cmd.color;
      if (cmd.hidden === false) delete next.hidden;
      else if (cmd.hidden) next.hidden = true;
      if (cmd.material === 'default') delete next.material;
      else if (cmd.material) next.material = { ...cmd.material };
      if (cmd.texture === 'default') delete next.texture;
      else if (cmd.texture) next.texture = { ...cmd.texture };
      return done(model, replaceObject(model, next as CadObject), cmd, target.id);
    }

    case 'shell': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'box' && target.kind !== 'cylinder' && target.kind !== 'extrude')
        return fail('쉘은 박스·원통·돌출에만 할 수 있습니다');
      if (cmd.thickness === 0) {
        const { shell: _removed, ...rest } = target;
        void _removed;
        return done(model, replaceObject(model, rest as CadObject), cmd, target.id);
      }
      if (cmd.thickness < LIMITS.minDimension) return fail(`쉘 두께는 ${LIMITS.minDimension}mm 이상이어야 합니다 (0 은 제거)`);
      const shell: Shell = { thickness: cmd.thickness, open: cmd.open ?? [] };
      const err = shellError(target, shell, model);
      if (err) return fail(err);
      return done(model, replaceObject(model, { ...target, shell } as CadObject), cmd, target.id);
    }

    case 'pattern':
      return createPattern(model, cmd);

    case 'set_pattern': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'pattern') return fail(`'${target.name}'은(는) 패턴이 아닙니다`);
      if (cmd.pattern.source !== target.pattern.source) return fail('패턴의 원본은 바꿀 수 없습니다');
      const err = patternError(cmd.pattern);
      if (err) return fail(err);
      return done(model, replaceObject(model, { ...target, pattern: cmd.pattern }), cmd, target.id);
    }

    case 'hole':
      return createHole(model, cmd);

    case 'edge_feature':
    case 'draft': {
      const source = findObject(model, cmd.target);
      if (!source) return missing(cmd.target);
      if (parentMap(model).has(source.id)) return fail(`'${source.name}'은(는) 다른 객체에 포함되어 있습니다. 상위 객체를 고르세요`);
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      if (1 + depthOf(model, source.id) > LIMITS.maxBooleanDepth) return fail(`중첩은 최대 ${LIMITS.maxBooleanDepth}단계까지 가능합니다`);
      const kind = cmd.type === 'draft' ? 'draft' : 'fillet';
      const id = cmd.id ?? nextId(model, kind);
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const label = cmd.type === 'draft' ? '구배' : cmd.feature === 'fillet' ? '필렛' : '모따기';
      const n = model.objects.filter((o) => o.kind === kind).length + 1;
      // 감싸는 좌표계 = 월드 (모서리 규칙 top·bottom·vertical, 구배 방향 +Z 가 월드 기준). 원본은 월드 변환을 자식 변환으로
      const obj: CadObject =
        cmd.type === 'draft'
          ? { id, name: cmd.name ?? `${label} ${n}`, kind: 'draft', draft: { source: source.id, angle: cmd.angle }, transform: IDENTITY }
          : {
              id,
              name: cmd.name ?? `${label} ${n}`,
              kind: 'fillet',
              fillet: { source: source.id, type: cmd.feature, size: cmd.size, edges: cmd.edges },
              transform: IDENTITY,
            };
      return done(model, { ...model, objects: [...model.objects, obj] }, cmd, id);
    }

    case 'set_edge_feature': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'fillet') return fail(`'${target.name}'은(는) 모서리 처리가 아닙니다`);
      const f = { ...target.fillet, ...(cmd.feature ? { type: cmd.feature } : {}), ...(cmd.size !== undefined ? { size: cmd.size } : {}), ...(cmd.edges ? { edges: cmd.edges } : {}) };
      return done(model, replaceObject(model, { ...target, fillet: f }), cmd, target.id);
    }

    case 'add_mate': {
      const mates = model.mates ?? [];
      if (mates.length >= MAX_MATES) return fail(`메이트는 최대 ${MAX_MATES}개까지 가능합니다`);
      let id = cmd.id;
      if (!id) {
        let n = 1;
        while (mates.some((m) => m.id === `mate${n}`)) n++;
        id = `mate${n}`;
      }
      if (mates.some((m) => m.id === id)) return fail(`이미 있는 메이트 ID입니다: ${id}`);
      const mate: Mate = { id, type: cmd.mate, refs: cmd.refs, ...(cmd.value !== undefined ? { value: cmd.value } : {}), ...(cmd.flip ? { flip: true } : {}) };
      const err = mateError(model, mate);
      if (err) return fail(err);
      // 솔리드웍스처럼 둘째로 고른 부품이 움직인다: 나머지 부품을 붙잡고 먼저 풀고, 안 되면 모두 풀어 본다
      const next = { ...model, mates: [...mates, mate] };
      const mover = refObject(mate.refs[mate.refs.length - 1]!);
      const others = new Set(next.mates.flatMap((m) => m.refs.map(refObject)).filter((id) => id !== mover));
      const first = solveMates(next, others);
      const solved = first.ok ? first : solveMates(next);
      return solved.ok ? done(model, solved.model, cmd, null) : fail(solved.error);
    }

    case 'set_mate': {
      const mates = model.mates ?? [];
      const m = mates.find((x) => x.id === cmd.mate);
      if (!m) return fail(`존재하지 않는 메이트입니다: ${cmd.mate}`);
      const next: Mate = { ...m, ...(cmd.value !== undefined ? { value: cmd.value } : {}) };
      if (cmd.flip !== undefined) {
        if (cmd.flip) next.flip = true;
        else delete next.flip;
      }
      const solved = solveMates({ ...model, mates: mates.map((x) => (x.id === m.id ? next : x)) });
      return solved.ok ? done(model, solved.model, cmd, null) : fail(solved.error);
    }

    case 'delete_mate': {
      const mates = model.mates ?? [];
      if (!mates.some((m) => m.id === cmd.mate)) return fail(`존재하지 않는 메이트입니다: ${cmd.mate}`);
      const rest = mates.filter((m) => m.id !== cmd.mate);
      const { mates: _m, ...base } = model;
      void _m;
      return done(model, rest.length ? { ...base, mates: rest } : base, cmd, null);
    }

    case 'set_drawing': {
      const v = cmd.drawing.views;
      if (new Set(v).size !== v.length) return fail('도면 보기가 중복되었습니다');
      const dims = cmd.drawing.dims ?? [];
      if (new Set(dims.map((d) => d.id)).size !== dims.length) return fail('도면 치수 ID 가 중복되었습니다');
      const bad = dims.find((d) => (d.kind === 'diameter') === !!d.b);
      if (bad) return fail(`치수 ${bad.id}: ${bad.kind === 'diameter' ? '지름 치수는 끝점이 하나입니다' : '길이 치수는 끝점이 둘입니다'}`);
      const sec = cmd.drawing.section;
      if (sec?.steps && sec.rect) return fail('계단 단면과 부분 단면은 함께 쓸 수 없습니다');
      if (sec?.steps?.some((st, i) => i > 0 && st.at <= sec.steps![i - 1]!.at)) return fail('계단 단면의 꺾이는 위치(at)는 오름차순이어야 합니다');
      const k = cmd.sheet ?? 0;
      if (k === 0) return done(model, { ...model, drawing: cmd.drawing }, cmd, null);
      // 2장째부터 (형식 v27): 있는 시트는 바꾸고, 시트 수와 같은 번호는 새로 붙인다
      const extra = model.drawingSheets ?? [];
      if (k - 1 > extra.length) return fail(`도면 시트 ${k + 1}장째가 없습니다 (지금 ${extra.length + 1}장)`);
      if (k - 1 === extra.length && extra.length >= MAX_EXTRA_SHEETS) return fail(`도면은 최대 ${MAX_EXTRA_SHEETS + 1}장까지입니다`);
      const sheets = [...extra];
      sheets[k - 1] = cmd.drawing;
      return done(model, { ...model, drawingSheets: sheets }, cmd, null);
    }
    case 'delete_drawing_sheet': {
      const extra = model.drawingSheets ?? [];
      if (cmd.sheet > extra.length) return fail(`도면 시트 ${cmd.sheet + 1}장째가 없습니다`);
      const sheets = extra.filter((_, i) => i !== cmd.sheet - 1);
      const { drawingSheets: _old, ...rest } = model;
      return done(model, sheets.length ? { ...rest, drawingSheets: sheets } : rest, cmd, null);
    }

    case 'insert_part':
      return insertPart(model, cmd);

    case 'set_thin': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'extrude' || target.extrude.thin === undefined) return fail(`'${target.name}'은(는) 리브(얇은 돌출)가 아닙니다`);
      const next = { ...target, extrude: { ...target.extrude, thin: cmd.thin } };
      const sk = model.sketches.find((x) => x.id === target.extrude.sketch);
      const prof = sk ? profileOf(sk, next.extrude) : null;
      const err = prof?.type === 'polygon' ? polygonError(prof.points) : null;
      if (err) return fail(`리브 단면: ${err} (두께를 줄이세요)`);
      return done(model, replaceObject(model, next), cmd, target.id);
    }

    case 'set_draft': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'draft') return fail(`'${target.name}'은(는) 구배가 아닙니다`);
      return done(model, replaceObject(model, { ...target, draft: { ...target.draft, angle: cmd.angle } }), cmd, target.id);
    }

    case 'import_step': {
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      if (!cmd.data.length) return fail('STEP 파일이 비어 있습니다');
      const id = cmd.id ?? nextId(model, 'step');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const obj: CadObject = {
        id,
        name: cmd.name ?? `STEP ${model.objects.filter((o) => o.kind === 'step').length + 1}`,
        kind: 'step',
        step: { data: cmd.data },
        transform: { position: cmd.position ?? [0, 0, 0], rotation: [0, 0, 0] },
      };
      return done(model, { ...model, objects: [...model.objects, obj] }, cmd, id);
    }

    case 'import_mesh': {
      const err = meshError(cmd);
      if (err) return fail(err);
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'mesh');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const obj: CadObject = {
        id,
        name: cmd.name ?? `가져온 메시 ${model.objects.filter((o) => o.kind === 'mesh').length + 1}`,
        kind: 'mesh',
        mesh: { positions: cmd.positions, indices: cmd.indices },
        transform: { position: cmd.position ?? [0, 0, 0], rotation: [0, 0, 0] },
      };
      return done(model, { ...model, objects: [...model.objects, obj] }, cmd, id);
    }
    case 'add_mesh': {
      if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
      const id = cmd.id ?? nextId(model, 'mesh');
      if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
      const polymesh = primitiveMesh(cmd.primitive, cmd.params ?? {});
      if (polymesh.verts.length > MAX_POLY_VERTS || polymesh.faces.length > MAX_POLY_FACES) return fail('메시가 너무 큽니다 (점·면 최대 5만 개)');
      const label = MESH_PRIMITIVE_LABEL[cmd.primitive];
      const obj: CadObject = {
        id,
        name: cmd.name ?? `${label} ${model.objects.filter((o) => o.kind === 'polymesh' && o.name.startsWith(`${label} `)).length + 1}`,
        kind: 'polymesh',
        polymesh,
        transform: { position: cmd.position ?? [0, 0, 0], rotation: [0, 0, 0] },
      };
      return done(model, { ...model, objects: [...model.objects, obj] }, cmd, id);
    }
    case 'mesh_edit': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'polymesh') return fail(`'${target.name}'은(는) 메시가 아니라 편집 모드로 고칠 수 없습니다`);
      const r = applyMeshEdit(target.polymesh, cmd.edit);
      if (typeof r === 'string') return fail(r);
      if (r.verts.length > MAX_POLY_VERTS || r.faces.length > MAX_POLY_FACES) return fail('메시가 너무 큽니다 (점·면 최대 5만 개)');
      const err = polyMeshError(r);
      if (err) return fail(`메시 편집 실패: ${err}`);
      if (r.verts.some((v) => v.some((c) => !Number.isFinite(c) || Math.abs(c) > LIMITS.maxCoordinate))) return fail('점 좌표가 허용 범위를 벗어납니다');
      const updated = { ...target, polymesh: r } as CadObject;
      return done(model, { ...model, objects: model.objects.map((o) => (o.id === target.id ? updated : o)) }, cmd, target.id);
    }
    case 'convert_to_mesh': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (parentMap(model).has(target.id)) return fail(`'${target.name}'은(는) 다른 불리언·패턴에 포함되어 있습니다 — 맨 위 객체를 변환하세요`);
      if (target.kind === 'polymesh') return fail(`'${target.name}'은(는) 이미 메시입니다`);
      const err = polyMeshError(cmd.polymesh);
      if (err) return fail(`메시로 변환할 수 없습니다: ${err}`);
      const gone = new Set(subtreeIds(model, target.id));
      if ((model.mates ?? []).some((m) => m.refs.some((r) => gone.has(typeof r === 'string' ? r.split('.')[0]! : r.object))))
        return fail(`'${target.name}'에 메이트가 걸려 있어 메시로 바꿀 수 없습니다 (메이트를 먼저 지우세요)`);
      const obj: CadObject = {
        id: target.id,
        name: target.name,
        kind: 'polymesh',
        polymesh: cmd.polymesh,
        transform: target.transform,
        ...(target.color ? { color: target.color } : {}),
        ...(target.hidden ? { hidden: true } : {}),
      };
      const objects = model.objects.filter((o) => o.id === target.id || !gone.has(o.id)).map((o) => (o.id === target.id ? obj : o));
      return done(model, { ...model, objects }, cmd, target.id);
    }
    case 'set_modifiers':
    case 'apply_modifier':
    case 'set_shading': {
      const target = findObject(model, cmd.target);
      if (!target) return missing(cmd.target);
      if (target.kind !== 'polymesh') return fail(`'${target.name}'은(는) 메시가 아니라 모디파이어를 쓸 수 없습니다`);
      let updated: CadObject;
      if (cmd.type === 'set_shading') updated = { ...target, smooth: cmd.smooth || undefined };
      else if (cmd.type === 'set_modifiers') {
        if (estimateFaces(target.polymesh, cmd.modifiers) > MAX_EVALUATED_FACES)
          return fail(`모디파이어 결과가 너무 큽니다 (면 ${MAX_EVALUATED_FACES.toLocaleString()}개 초과) — 세분 단계나 배열 수를 줄이세요`);
        updated = { ...target, modifiers: cmd.modifiers.length ? cmd.modifiers : undefined };
      } else {
        const mods = target.modifiers ?? [];
        if (!mods.length) return fail(`'${target.name}'에 적용할 모디파이어가 없습니다`);
        const n = cmd.all ? mods.length : 1;
        const baked = evaluateModifiers(target.polymesh, mods.slice(0, n));
        if (baked.verts.length > MAX_POLY_VERTS || baked.faces.length > MAX_POLY_FACES) return fail('적용하면 메시가 너무 큽니다 (점·면 최대 5만 개)');
        const rest = mods.slice(n);
        updated = { ...target, polymesh: baked, modifiers: rest.length ? rest : undefined };
      }
      // 빈 선택 항목은 저장하지 않는다
      const clean = Object.fromEntries(Object.entries(updated).filter(([, v]) => v !== undefined)) as CadObject;
      return done(model, { ...model, objects: model.objects.map((o) => (o.id === target.id ? clean : o)) }, cmd, target.id);
    }
  }
}

const MESH_PRIMITIVE_LABEL: Record<MeshPrimitive, string> = {
  cube: '큐브', plane: '평면', uv_sphere: 'UV 구', cylinder: '원기둥', cone: '원뿔', torus: '도넛', grid: '격자',
};

/** 편집 모드 연산 하나를 적용 (실패하면 이유 문자열) */
function applyMeshEdit(m: PolyMesh, e: MeshEdit): PolyMesh | string {
  const nv = m.verts.length;
  const nf = m.faces.length;
  const badV = (ids: readonly number[]) => ids.some((i) => i >= nv);
  const badF = (ids: readonly number[]) => ids.some((i) => i >= nf);
  switch (e.op) {
    case 'transform':
      if (badV(e.verts)) return '없는 점을 가리킵니다';
      return transformVerts(m, e.verts, e.matrix);
    case 'extrude':
      if (badF(e.faces)) return '없는 면을 가리킵니다';
      return extrudeFaces(m, e.faces, e.offset).mesh;
    case 'inset':
      if (badF(e.faces)) return '없는 면을 가리킵니다';
      return insetFaces(m, e.faces, e.thickness).mesh;
    case 'delete':
      if (badV(e.verts)) return '없는 점을 가리킵니다';
      return deleteElements(m, e.verts, e.mode);
    case 'loop_cut': {
      if (badV(e.edge)) return '없는 점을 가리킵니다';
      const r = loopCut(m, e.edge[0], e.edge[1], e.factor);
      return r.sel.length === 0 ? '그 선을 지나는 사각형 띠가 없습니다' : r.mesh;
    }
    case 'subdivide':
      if (badF(e.faces)) return '없는 면을 가리킵니다';
      return subdivideFaces(m, e.faces);
    case 'merge':
      if (badV(e.verts)) return '없는 점을 가리킵니다';
      return mergeVerts(m, e.verts);
    case 'fill':
      if (badV(e.verts)) return '없는 점을 가리킵니다';
      if (new Set(e.verts).size !== e.verts.length) return '같은 점을 두 번 골랐습니다';
      return fillFace(m, e.verts);
    case 'bisect': {
      if (badF(e.faces)) return '없는 면을 가리킵니다';
      if (Math.hypot(...e.normal) < 1e-9) return '자르는 평면의 방향이 없습니다';
      return bisectFaces(m, e.faces, e.point, e.normal).mesh;
    }
    case 'bevel': {
      if (badV(e.verts)) return '없는 점을 가리킵니다';
      const sel = new Set(e.verts);
      const r = bevelEdges(m, edges(m).filter(([a, b]) => sel.has(a) && sel.has(b)), e.width, e.segments ?? 1);
      return typeof r === 'string' ? r : r.mesh;
    }
    case 'set_verts': {
      if (badV(e.verts)) return '없는 점을 가리킵니다';
      if (e.positions.length !== e.verts.length) return '점 번호와 좌표 개수가 다릅니다';
      const verts = [...m.verts];
      e.verts.forEach((v, i) => (verts[v] = [...e.positions[i]!] as V3));
      return { verts, faces: m.faces };
    }
    case 'remesh':
      return voxelRemesh(m, e.voxel, e.smooth ?? 2);
    case 'replace': {
      const n = e.mesh.verts.length;
      if (e.mesh.faces.some((f) => f.some((v) => v >= n))) return '없는 점을 가리킵니다';
      return { verts: e.mesh.verts.map((v) => [...v] as V3), faces: e.mesh.faces.map((f) => [...f]) };
    }
  }
}

/** set_params 로 객체를 다시 만들 때 유지하는 공통 선택 필드 */
function keepCommon(o: CadObject): Partial<CadObject> {
  const out: Record<string, unknown> = {};
  if (o.suppressed) out.suppressed = true;
  if (o.hidden) out.hidden = true;
  if (o.color) out.color = o.color;
  return out as Partial<CadObject>;
}

function createPattern(model: ModelDefinition, cmd: PatternCommand): ExecuteResult {
  const source = findObject(model, cmd.pattern.source);
  if (!source) return missing(cmd.pattern.source);
  if (parentMap(model).has(source.id)) return fail(`'${source.name}'은(는) 이미 다른 불리언·패턴에 포함되어 있습니다`);
  const err = patternError(cmd.pattern);
  if (err) return fail(err);
  if (model.objects.length >= LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
  const id = cmd.id ?? nextId(model, 'pattern');
  if (idTaken(model, id)) return fail(`이미 존재하는 ID입니다: ${id}`);
  const depth = 1 + depthOf(model, source.id);
  if (depth > LIMITS.maxBooleanDepth) return fail(`불리언·패턴 중첩은 최대 ${LIMITS.maxBooleanDepth}단계까지 가능합니다`);
  // 패턴 좌표계 = 월드 (축·평면이 월드 원점을 지난다). 원본은 월드 변환을 그대로 자식 변환으로 쓴다
  const label = PATTERN_LABEL[cmd.pattern.type];
  const count = model.objects.filter((o) => o.kind === 'pattern' && o.pattern.type === cmd.pattern.type).length;
  const obj: CadObject = { id, name: cmd.name ?? `${label} ${count + 1}`, kind: 'pattern', pattern: cmd.pattern, transform: IDENTITY };
  return done(model, { ...model, objects: [...model.objects, obj] }, cmd, id);
}

/**
 * 구멍 가공: 면 좌표 (u, v) 에서 면 안쪽으로. 구멍 도구의 윗면(z = depth)이 가공 면에 오도록
 * 월드 변환 = 객체 월드 · 면 좌표계 · T(u, v, −depth).
 */
function createHole(model: ModelDefinition, cmd: HoleCommand): ExecuteResult {
  const target = findObject(model, cmd.target);
  if (!target) return missing(cmd.target);
  if (parentMap(model).has(target.id)) return fail(`'${target.name}'은(는) 다른 불리언·패턴에 포함되어 있습니다. 상위 객체에 구멍을 내세요`);
  const faces = facesOf(model, target);
  if (!faces.includes(cmd.face)) return fail(`'${target.name}'에는 '${cmd.face}' 면이 없습니다 (있는 면: ${faces.join(', ') || '없음'})`);
  const params = {
    diameter: cmd.diameter,
    depth: cmd.depth,
    cboreDiameter: cmd.cboreDiameter ?? 0,
    cboreDepth: cmd.cboreDepth ?? 0,
    csinkDiameter: cmd.csinkDiameter ?? 0,
  };
  const parsed = PARAMS_SCHEMAS.hole.safeParse(params);
  if (!parsed.success) return fail(`구멍: ${parsed.error.issues[0]?.message ?? '잘못된 값'}`);
  const face = faceLocalMatrix(model, target, cmd.face)!;
  const world = toMatrix(target.transform).multiply(face).multiply(new Matrix4().makeTranslation(cmd.at[0], cmd.at[1], -cmd.depth));
  const holeTransform = fromMatrix(world);
  if (!withinBounds(holeTransform.position)) return fail('구멍 위치가 허용 작업 영역을 벗어납니다');
  if (model.objects.length + 2 > LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
  const holeId = cmd.id ?? nextId(model, 'hole');
  if (idTaken(model, holeId)) return fail(`이미 존재하는 ID입니다: ${holeId}`);
  const hole: CadObject = {
    id: holeId,
    name: `구멍 Ø${parsed.data.diameter}`,
    kind: 'hole',
    params: parsed.data,
    transform: holeTransform,
  };
  // 이미 빼기 결과면 그 빼기의 도구로 더한다 (구멍마다 중첩이 깊어지지 않게)
  if (target.kind === 'boolean' && target.boolean.operation === 'cut') {
    if (target.boolean.tools.length >= LIMITS.maxBooleanTools) return fail(`빼기 도구는 최대 ${LIMITS.maxBooleanTools}개까지 가능합니다`);
    const localHole = { ...hole, transform: relativeTransform(target.transform, holeTransform) };
    const updated: CadObject = { ...target, boolean: { ...target.boolean, tools: [...target.boolean.tools, holeId] } };
    const objects = [...model.objects.map((o) => (o.id === target.id ? updated : o)), localHole];
    return done(model, { ...model, objects }, cmd, target.id);
  }
  const withHole = { ...model, objects: [...model.objects, hole] };
  const r = createBoolean(withHole, { type: 'cut', base: target.id, tools: [holeId], name: `${target.name} 구멍` });
  return r.ok ? { ...r, model: r.model, command: cmd } : r;
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

/** 부품 삽입: ID 를 겹치지 않게 다시 붙여 합친다 (참조 키만 바꾼다 — 스케치 요소·구속 ID 는 스케치 안의 이름이라 그대로) */
function insertPart(model: ModelDefinition, cmd: Extract<CadCommand, { type: 'insert_part' }>): ExecuteResult {
  const part = cmd.part;
  if (model.objects.length + part.objects.length + 1 > LIMITS.maxObjects) return fail(`객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`);
  if (model.sketches.length + part.sketches.length > LIMITS.maxSketches) return fail(`스케치는 최대 ${LIMITS.maxSketches}개까지 가능합니다`);
  const taken = new Set([...model.objects.map((o) => o.id), ...model.sketches.map((k) => k.id)]);
  const partIds = [...part.objects.map((o) => o.id), ...part.sketches.map((k) => k.id)];
  // 겹치는 ID 가 하나라도 있으면 모든 ID 에 같은 꼬리표 _pN 을 붙인다 (N = 겹치지 않는 가장 작은 수)
  const rename = (id: string, n: number) => (n === 0 ? id : `${id.slice(0, 58)}_p${n}`);
  let n = 0;
  while (partIds.some((id) => taken.has(rename(id, n)))) n++;
  const map = new Map(partIds.map((id) => [id, rename(id, n)]));
  const REF_KEYS = new Set(['base', 'source', 'sketch', 'pathSketch', 'object']);
  const remap = (v: unknown, key = ''): unknown => {
    if (typeof v === 'string') return REF_KEYS.has(key) || key === 'tools' ? (map.get(v) ?? v) : v;
    if (Array.isArray(v)) return v.map((x) => remap(x, key));
    if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([kk, x]) => [kk, remap(x, kk)]));
    return v;
  };
  const objects = part.objects.map((o) => ({ ...(remap(o) as CadObject), id: map.get(o.id)! }));
  const sketches = part.sketches.map((sk) => ({ ...sk, id: map.get(sk.id)!, plane: remap(sk.plane) as Sketch['plane'] }));
  const sub: ModelDefinition = { schemaVersion: model.schemaVersion, units: 'mm', sketches, objects };
  const roots = topLevelObjects(sub);
  const pos = cmd.position ?? [0, 0, 0];
  let added = objects;
  let rootId: ObjectId;
  if (roots.length === 1) {
    const r = roots[0]!;
    rootId = r.id;
    added = objects.map((o) => (o.id === r.id ? { ...o, name: cmd.name, transform: { ...o.transform, position: addVec(o.transform.position, pos) } } : o));
  } else {
    rootId = nextId({ ...model, objects: [...model.objects, ...objects] }, 'part');
    const group: CadObject = {
      id: rootId,
      name: cmd.name,
      kind: 'boolean',
      boolean: { operation: 'union', base: roots[0]!.id, tools: roots.slice(1).map((o) => o.id) },
      transform: { position: pos, rotation: [0, 0, 0] },
    };
    added = [...objects, group];
  }
  const next: ModelDefinition = { ...model, sketches: [...model.sketches, ...sketches], objects: [...model.objects, ...added] };
  const errors = validateGraph(next);
  if (errors.length) return fail(`부품을 넣을 수 없습니다: ${errors[0]}`);
  return done(model, next, cmd, rootId);
}

function done(
  _before: ModelDefinition,
  after: ModelDefinition,
  command: CadCommand,
  affectedId: ObjectId | null,
): ExecuteResult {
  return { ok: true, model: after, command, affectedId };
}
