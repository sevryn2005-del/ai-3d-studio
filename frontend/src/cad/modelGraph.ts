/**
 * 객체 간 부모-자식 관계 (불리언 트리).
 * 관계는 불리언 객체의 base/tools 참조로만 표현되며, 이 모듈이 그로부터 유도한다.
 */
import { facesOf } from './sketchPlane';
import type { CadObject, ModelDefinition, ObjectId, Sketch } from './commandTypes';
import { LIMITS } from './commandTypes';
import { edgeFeatureError } from './edgeFeature';
import { patternError, shellError } from './features';
import { refTarget, sketchErrors, sketchRefs, revolveProfileError } from './sketch';
import { meshError } from './meshData';
import { MATE_TOLERANCE, mateError, mateResiduals } from './mates';

export function childIds(obj: CadObject): ObjectId[] {
  if (obj.kind === 'boolean') return [obj.boolean.base, ...obj.boolean.tools];
  const src = wrapperSource(obj);
  return src ? [src] : [];
}

/**
 * 원본 하나를 감싸는 피처(패턴·대칭·크기 조정·모서리 처리·구배)의 원본 ID. 아니면 null.
 * 감싸는 객체를 지우면 원본은 월드 위치 그대로 남는다 (솔리드웍스와 같음)
 */
export function wrapperSource(obj: CadObject): ObjectId | null {
  if (obj.kind === 'pattern') return obj.pattern.source;
  if (obj.kind === 'fillet') return obj.fillet.source;
  if (obj.kind === 'draft') return obj.draft.source;
  return null;
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

export function sketchIndex(model: ModelDefinition): Map<ObjectId, Sketch> {
  return new Map(model.sketches.map((s) => [s.id, s]));
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

/** 트리 깊이: 기본 도형 = 0, 기본 도형만 가진 불리언·패턴 = 1 */
export function depthOf(model: ModelDefinition, id: ObjectId, index = byId(model)): number {
  const o = index.get(id);
  if (!o || childIds(o).length === 0) return 0;
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
  // 스케치: 규칙 + 객체·스케치 ID 공간 중복
  const sketchIds = new Set<ObjectId>();
  for (const sk of model.sketches) {
    if (sketchIds.has(sk.id) || index.has(sk.id)) errors.push(`중복된 ID입니다: ${sk.id}`);
    sketchIds.add(sk.id);
    errors.push(...sketchErrors(sk));
  }
  for (const o of model.objects) {
    for (const ref of sketchRefs(o)) {
      const sk = model.sketches.find((x) => x.id === ref.sketch);
      const prof = sk ? refTarget(sk, ref) : null;
      if (!sk) errors.push(`${o.id}: 존재하지 않는 스케치를 참조합니다: ${ref.sketch}`);
      else if (!prof)
        errors.push(
          ref.open || ref.thin !== undefined
            ? `${o.id}: 스케치 ${sk.id} 에 열린 선(구성선·경로) ${ref.profile} 이(가) 없습니다`
            : `${o.id}: 스케치 ${sk.id} 에 사용할 수 있는 프로파일 ${ref.profile} 이(가) 없습니다`,
        );
      else if ((o.kind === 'revolve' || o.kind === 'helix') && !Array.isArray(prof)) {
        const err = revolveProfileError(prof);
        if (err) errors.push(`${o.id}: ${err}`);
      }
    }
    if (o.kind === 'mesh') {
      const err = meshError(o.mesh);
      if (err) errors.push(`${o.id}: ${err}`);
    }
  }
  // 면 평면: 붙은 객체와 면 이름 (docs/design-face-sketch.md)
  for (const sk of model.sketches) {
    if (sk.plane.type !== 'face') continue;
    const anchor = index.get(sk.plane.object);
    if (!anchor) errors.push(`${sk.id}: 존재하지 않는 객체의 면에 붙어 있습니다: ${sk.plane.object}`);
    else if (!facesOf(model, anchor).includes(sk.plane.face))
      errors.push(`${sk.id}: ${anchor.name} 에는 '${sk.plane.face}' 면이 없습니다 (있는 면: ${facesOf(model, anchor).join(', ') || '없음'})`);
  }
  const cycle = dependencyCycle(model);
  if (cycle) errors.push(cycle);
  for (const o of model.objects) {
    if (o.kind === 'box' && o.edgeFeature) {
      const err = edgeFeatureError(o.params, o.edgeFeature);
      if (err) errors.push(`${o.id}: ${err}`);
    }
    if ((o.kind === 'box' || o.kind === 'cylinder' || o.kind === 'extrude') && o.shell) {
      const err = shellError(o, o.shell, model);
      if (err) errors.push(`${o.id}: ${err}`);
    }
    if (o.kind === 'pattern') {
      const err = patternError(o.pattern);
      if (err) errors.push(`${o.id}: ${err}`);
    }
  }
  const parentOf = new Map<ObjectId, ObjectId>();
  for (const o of model.objects) {
    if (childIds(o).length === 0) continue;
    const ids = childIds(o);
    if (new Set(ids).size !== ids.length) errors.push(`${o.id}: 같은 객체가 두 번 이상 참조되었습니다`);
    for (const c of ids) {
      if (c === o.id) errors.push(`${o.id}: 자기 자신을 참조할 수 없습니다`);
      else if (!index.has(c)) errors.push(`${o.id}: 존재하지 않는 객체를 참조합니다: ${c}`);
      else if (parentOf.has(c) && parentOf.get(c) !== o.id)
        errors.push(`${c}: 두 개 이상의 불리언·패턴에서 사용되었습니다`);
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
  // 조립 메이트 (형식 v11): 형식 + 저장된 변환이 메이트를 만족하는지 (해석기가 푼 결과만 저장된다)
  const mateIds = new Set<string>();
  for (const m of model.mates ?? []) {
    if (mateIds.has(m.id)) errors.push(`메이트 ID 가 중복되었습니다: ${m.id}`);
    mateIds.add(m.id);
    const err = mateError(model, m);
    if (err) errors.push(`메이트 ${m.id}: ${err}`);
  }
  for (const [id, res] of mateResiduals(model)) if (res > MATE_TOLERANCE) errors.push(`메이트 ${id} 을(를) 만족하지 않습니다 (오차 ${res.toExponential(1)})`);
  return errors;
}

/**
 * 의존 순환 검사: 돌출 → 스케치, 스케치(면 평면) → 붙은 객체, 불리언 → 자식.
 * 예: 판의 스케치를 판 자신의 윗면에 붙이면 순환. 순환이 있으면 사용자용 메시지, 없으면 null.
 */
export function dependencyCycle(model: ModelDefinition): string | null {
  const edges = new Map<string, string[]>();
  const add = (from: string, to: string) => edges.set(from, [...(edges.get(from) ?? []), to]);
  for (const o of model.objects) {
    for (const ref of sketchRefs(o)) add(`o:${o.id}`, `s:${ref.sketch}`);
    for (const c of childIds(o)) add(`o:${o.id}`, `o:${c}`);
  }
  for (const sk of model.sketches) if (sk.plane.type === 'face') add(`s:${sk.id}`, `o:${sk.plane.object}`);
  const state = new Map<string, 1 | 2>(); // 1 = 방문 중, 2 = 끝
  const visit = (node: string): string | null => {
    if (state.get(node) === 2) return null;
    if (state.get(node) === 1) return node;
    state.set(node, 1);
    for (const next of edges.get(node) ?? []) {
      const hit = visit(next);
      if (hit) return hit;
    }
    state.set(node, 2);
    return null;
  };
  for (const node of edges.keys()) {
    const hit = visit(node);
    if (hit) return `면 참조가 순환합니다: ${hit.slice(2)} (스케치를 자신이 만든 형상의 면에 붙일 수 없습니다)`;
  }
  return null;
}
