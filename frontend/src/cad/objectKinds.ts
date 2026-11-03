/**
 * 도형 종류별 메타데이터 (표시 이름, 파라미터 목록, 크기 계산).
 * UI 와 실행기가 공유하며, 새 도형을 추가할 때 이 파일만 확장하면 패널/목록이 자동으로 따라온다.
 */
import type { BooleanOperation, CadObject, ModelDefinition, ObjectKind } from './commandTypes';
import { formatMm } from './units';
import { describeEdgeFeature } from './edgeFeature';
import { findSketch, resolveProfile } from './sketch';
import { planeSizeToLocal } from './sketchPlane';

export interface ParamField {
  key: string;
  label: string;
}

export const KIND_INFO: Record<ObjectKind, { label: string; params: ParamField[] }> = {
  box: {
    label: '박스',
    params: [
      { key: 'width', label: '너비 (X)' },
      { key: 'depth', label: '깊이 (Y)' },
      { key: 'height', label: '높이 (Z)' },
    ],
  },
  cylinder: {
    label: '원통',
    params: [
      { key: 'radius', label: '반지름' },
      { key: 'height', label: '높이 (Z)' },
    ],
  },
  sphere: {
    label: '구',
    params: [{ key: 'radius', label: '반지름' }],
  },
  cone: {
    label: '원뿔',
    params: [
      { key: 'radiusBottom', label: '아래 반지름' },
      { key: 'radiusTop', label: '위 반지름' },
      { key: 'height', label: '높이 (Z)' },
    ],
  },
  extrude: { label: '돌출', params: [{ key: 'distance', label: '돌출 거리' }] },
  boolean: { label: '불리언', params: [] },
};

export const OPERATION_INFO: Record<BooleanOperation, { label: string; symbol: string; verb: string }> = {
  union: { label: '합치기', symbol: '∪', verb: '합치기' },
  cut: { label: '빼기', symbol: '−', verb: '빼기' },
  intersect: { label: '교차', symbol: '∩', verb: '교차' },
};

export function kindLabel(obj: CadObject): string {
  return obj.kind === 'boolean' ? OPERATION_INFO[obj.boolean.operation].label : KIND_INFO[obj.kind].label;
}

/** 회전 전 로컬 바운딩 박스 크기 [X, Y, Z] (mm). 불리언은 기준(base) 객체 크기로 근사한다. */
export function localSize(obj: CadObject, model: ModelDefinition): [number, number, number] {
  switch (obj.kind) {
    case 'box':
      return [obj.params.width, obj.params.depth, obj.params.height];
    case 'cylinder':
      return [obj.params.radius * 2, obj.params.radius * 2, obj.params.height];
    case 'sphere':
      return [obj.params.radius * 2, obj.params.radius * 2, obj.params.radius * 2];
    case 'cone': {
      const d = Math.max(obj.params.radiusBottom, obj.params.radiusTop) * 2;
      return [d, d, obj.params.height];
    }
    case 'extrude': {
      const p = extrudeProfile(obj, model);
      if (!p) return [0, 0, obj.params.distance];
      const d = obj.params.distance;
      return planeSizeToLocal(p.plane, p.type === 'rectangle' ? [p.width, p.height, d] : [p.diameter, p.diameter, d]);
    }
    case 'boolean': {
      const base = model.objects.find((o) => o.id === obj.boolean.base);
      return base ? localSize(base, model) : [0, 0, 0];
    }
  }
}

export function extrudeProfile(obj: Extract<CadObject, { kind: 'extrude' }>, model: ModelDefinition) {
  const sketch = findSketch(model, obj.extrude.sketch);
  return sketch ? resolveProfile(sketch, obj.extrude.profile) : null;
}

/** 목록 표시용 크기 요약. 예: "20×20×50", "Ø20×30", "Ø40", "− 1개" */
export function sizeSummary(obj: CadObject, model?: ModelDefinition): string {
  switch (obj.kind) {
    case 'box': {
      const dims = `${formatMm(obj.params.width)}×${formatMm(obj.params.depth)}×${formatMm(obj.params.height)}`;
      return obj.edgeFeature ? `${dims} ${describeEdgeFeature(obj.edgeFeature)}` : dims;
    }
    case 'cylinder':
      return `Ø${formatMm(obj.params.radius * 2)}×${formatMm(obj.params.height)}`;
    case 'sphere':
      return `Ø${formatMm(obj.params.radius * 2)}`;
    case 'cone':
      return `Ø${formatMm(obj.params.radiusBottom * 2)}→Ø${formatMm(obj.params.radiusTop * 2)}×${formatMm(obj.params.height)}`;
    case 'extrude': {
      const p = model ? extrudeProfile(obj, model) : null;
      const d = formatMm(obj.params.distance);
      if (!p) return `돌출 ${d}`;
      return p.type === 'rectangle' ? `${formatMm(p.width)}×${formatMm(p.height)}×${d}` : `Ø${formatMm(p.diameter)}×${d}`;
    }
    case 'boolean': {
      const n = obj.boolean.tools.length;
      return `${OPERATION_INFO[obj.boolean.operation].symbol} ${n}개`;
    }
  }
}
