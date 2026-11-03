/**
 * 도형 종류별 메타데이터 (표시 이름, 파라미터 목록, 크기 계산).
 * UI 와 실행기가 공유하며, 새 도형을 추가할 때 이 파일만 확장하면 패널/목록이 자동으로 따라온다.
 */
import type { BooleanOperation, CadObject, ModelDefinition, ObjectKind } from './commandTypes';
import { formatMm } from './units';
import { describeEdgeFeature } from './edgeFeature';
import { findSketch, resolveProfile } from './sketch';
import { extrudeLocalMatrix, extrudeLocalSize } from './sketchPlane';

export interface ParamField {
  key: string;
  label: string;
  /** 기본 mm */
  unit?: 'mm' | '°';
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
  revolve: { label: '회전', params: [{ key: 'angle', label: '회전 각도', unit: '°' }] },
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
      const local = extrudeLocalMatrix(model, obj);
      const size: [number, number, number] = p.type === 'circle' ? [p.diameter, p.diameter, Math.abs(d)] : [p.width, p.height, Math.abs(d)];
      return local ? extrudeLocalSize(local, size) : size;
    }
    case 'revolve': {
      // 프로파일을 v 축 둘레로 돌린 바운딩 크기 (각도와 무관하게 한 바퀴 기준 근사): 평면 (2R, v 폭, 2R)
      const sk = findSketch(model, obj.revolve.sketch);
      const p = sk ? resolveProfile(sk, obj.revolve.profile) : null;
      if (!p) return [0, 0, 0];
      const r = p.type === 'circle' ? p.center[0] + p.diameter / 2 : p.center[0] + p.width / 2;
      const h = p.type === 'circle' ? p.diameter : p.height;
      const local = extrudeLocalMatrix(model, obj);
      return local ? extrudeLocalSize(local, [2 * r, h, 2 * r]) : [2 * r, h, 2 * r];
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
      return p.type === 'circle' ? `Ø${formatMm(p.diameter)}×${d}` : `${formatMm(p.width)}×${formatMm(p.height)}×${d}`;
    }
    case 'revolve': {
      const sk = model ? findSketch(model, obj.revolve.sketch) : undefined;
      const p = sk ? resolveProfile(sk, obj.revolve.profile) : null;
      const a = `${formatMm(obj.params.angle)}°`;
      if (!p) return `회전 ${a}`;
      const r = p.type === 'circle' ? p.center[0] + p.diameter / 2 : p.center[0] + p.width / 2;
      return `Ø${formatMm(2 * r)}×${formatMm(p.type === 'circle' ? p.diameter : p.height)} ${a}`;
    }
    case 'boolean': {
      const n = obj.boolean.tools.length;
      return `${OPERATION_INFO[obj.boolean.operation].symbol} ${n}개`;
    }
  }
}
