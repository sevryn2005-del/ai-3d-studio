/**
 * 객체 간 부모-자식 관계 (불리언 트리).
 * 관계는 불리언 객체의 base/tools 참조로만 표현되며, 이 모듈이 그로부터 유도한다.
 */
import type { CadObject, ModelDefinition, ObjectId } from './commandTypes';
import { LIMITS } from './commandTypes';
import { edgeFeatureError } from './edgeFeature';

export function childIds(obj: CadObject): ObjectId[] {
  return obj.kind === 'boolean' ? [obj.boolean.base, ...obj.boolean.tools] : [];
}

/** 자식 ID → 부모 ID */
export function parentMap(model: ModelDefinition): Map<ObjectId, ObjectId> {
  const map = new Map<ObjectId, ObjectId>();
  for (const o of model.objects) for (const c of childIds(o)) map.set(c, o.id);
  return map;
}

export function topLevelObjects(model: ModelDefinition): CadObject[] {
  const parents = parentMap(model);
  return model.objects.filter((o) => !parents.has(o.id));
}

export function byId(model: ModelDefinition): Map<ObjectId, CadObject> {
  return new Map(model.objects.map((o) => [o.id, o]));
}

/** 객체와 모든 하위 객체의 ID (자식 먼저, 자신은 마지막) */
export function subtreeIds(model: ModelDefinition, rootId: ObjectId): ObjectId[] {
  const index = byId(model);
  const out: ObjectId[] = [];
  const visit = (id: ObjectId) => {
    const o = index.get(id);
    if (!o) return;
    childIds(o).forEach(visit);
    out.push(id);
  };
  visit(rootId);
  return out;
}

/** 트리 깊이: 기본 도형 = 0, 기본 도형만 가진 불리언 = 1 */
export function depthOf(model: ModelDefinition, id: ObjectId, index = byId(model)): number {
  const o = index.get(id);
  if (!o || o.kind !== 'boolean') return 0;
  return 1 + Math.max(...childIds(o).map((c) => depthOf(model, c, index)));
}

/**
 * 모델 그래프 검증 (프로젝트 파일 불러오기 등 외부 입력용). 오류 메시지 목록을 반환한다.
 * 백엔드 app/cad/validation.py 의 check_model 과 같은 규칙.
 */
export function validateGraph(model: ModelDefinition): string[] {
  const errors: string[] = [];
  const index = new Map<ObjectId, CadObject>();
  for (const o of model.objects) {
    if (index.has(o.id)) errors.push(`중복된 객체 ID입니다: ${o.id}`);
    index.set(o.id, o);
  }
  for (const o of model.objects) {
    if (o.kind === 'box' && o.edgeFeature) {
      const err = edgeFeatureError(o.params, o.edgeFeature);
      if (err) errors.push(`${o.id}: ${err}`);
    }
  }
  const parentOf = new Map<ObjectId, ObjectId>();
  for (const o of model.objects) {
    if (o.kind !== 'boolean') continue;
    const ids = childIds(o);
    if (new Set(ids).size !== ids.length) errors.push(`${o.id}: 같은 객체가 두 번 이상 참조되었습니다`);
    for (const c of ids) {
      if (c === o.id) errors.push(`${o.id}: 자기 자신을 참조할 수 없습니다`);
      else if (!index.has(c)) errors.push(`${o.id}: 존재하지 않는 객체를 참조합니다: ${c}`);
      else if (parentOf.has(c) && parentOf.get(c) !== o.id)
        errors.push(`${c}: 두 개 이상의 불리언에서 사용되었습니다`);
      else parentOf.set(c, o.id);
    }
  }
  // 순환 검사: 부모를 따라 올라가다 자신을 만나면 순환
  for (const id of index.keys()) {
    const seen = new Set<ObjectId>();
    for (let cur: ObjectId | undefined = id; cur; cur = parentOf.get(cur)) {
      if (seen.has(cur)) {
        errors.push(`순환 참조가 있습니다: ${id}`);
        break;
      }
      seen.add(cur);
    }
  }
  if (errors.length === 0) {
    for (const o of model.objects) {
      if (depthOf(model, o.id, index) > LIMITS.maxBooleanDepth) {
        errors.push(`${o.id}: 불리언 중첩은 최대 ${LIMITS.maxBooleanDepth}단계까지 가능합니다`);
      }
    }
  }
  return errors;
}
