/**
 * 도형 종류별 메타데이터 (표시 이름, 파라미터 목록, 크기 계산).
 * UI 와 실행기가 공유하며, 새 도형을 추가할 때 이 파일만 확장하면 패널/목록이 자동으로 따라온다.
 */
import type { BooleanOperation, CadObject, ModelDefinition, ObjectKind } from './commandTypes';
import { formatMm } from './units';
import { describeEdgeFeature } from './edgeFeature';
import { findSketch, profileBounds, profileOf, resolveProfile } from './sketch';
import { extrudeLocalMatrix, extrudeLocalSize } from './sketchPlane';

export interface ParamField {
  key: string;
  label: string;
  /** 기본 mm */
  unit?: 'mm' | '°' | '개';
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
  hole: {
    label: '구멍',
    params: [
      { key: 'diameter', label: '지름' },
      { key: 'depth', label: '깊이' },
      { key: 'cboreDiameter', label: '카운터보어 지름 (0 = 없음)' },
      { key: 'cboreDepth', label: '카운터보어 깊이' },
      { key: 'csinkDiameter', label: '카운터싱크 지름 (0 = 없음)' },
    ],
  },
  pattern: { label: '패턴', params: [] },
  helix: {
    label: '헬릭스',
    params: [
      { key: 'pitch', label: '피치 (한 바퀴에 오르는 높이)' },
      { key: 'turns', label: '바퀴 수', unit: '개' },
    ],
  },
  loft: { label: '로프트', params: [] },
  sweep: { label: '스윕', params: [] },
  mesh: { label: '가져온 메시', params: [] },
  fillet: { label: '모서리 처리', params: [] },
  draft: { label: '구배', params: [] },
  step: { label: 'STEP', params: [] },
};

export const EDGE_RULE_LABEL = { all: '모든 모서리', vertical: '세로 모서리', top: '윗면 모서리', bottom: '아랫면 모서리' } as const;

export const PATTERN_LABEL = { linear: '선형 패턴', circular: '원형 패턴', mirror: '대칭 복사', scale: '크기 조정' } as const;

export const OPERATION_INFO: Record<BooleanOperation, { label: string; symbol: string; verb: string }> = {
  union: { label: '합치기', symbol: '∪', verb: '합치기' },
  cut: { label: '빼기', symbol: '−', verb: '빼기' },
  intersect: { label: '교차', symbol: '∩', verb: '교차' },
};

export function kindLabel(obj: CadObject): string {
  if (obj.kind === 'boolean') return OPERATION_INFO[obj.boolean.operation].label;
  if (obj.kind === 'pattern') return PATTERN_LABEL[obj.pattern.type];
  if (obj.kind === 'fillet') return obj.fillet.type === 'fillet' ? '필렛' : '모따기';
  return KIND_INFO[obj.kind].label;
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
      const b = profileBounds(p);
      const size: [number, number, number] = [b.width, b.height, Math.abs(d)];
      return local ? extrudeLocalSize(local, size) : size;
    }
    case 'revolve': {
      // 프로파일을 v 축 둘레로 돌린 바운딩 크기 (각도와 무관하게 한 바퀴 기준 근사): 평면 (2R, v 폭, 2R)
      const sk = findSketch(model, obj.revolve.sketch);
      const p = sk ? resolveProfile(sk, obj.revolve.profile) : null;
      if (!p) return [0, 0, 0];
      const b = profileBounds(p);
      const r = b.center[0] + b.width / 2;
      const h = b.height;
      const local = extrudeLocalMatrix(model, obj);
      return local ? extrudeLocalSize(local, [2 * r, h, 2 * r]) : [2 * r, h, 2 * r];
    }
    case 'boolean': {
      const base = model.objects.find((o) => o.id === obj.boolean.base);
      return base ? localSize(base, model) : [0, 0, 0];
    }
    case 'pattern': {
      const src = model.objects.find((o) => o.id === obj.pattern.source);
      return src ? localSize(src, model) : [0, 0, 0];
    }
    case 'hole': {
      const d = Math.max(obj.params.diameter, obj.params.cboreDiameter, obj.params.csinkDiameter);
      return [d, d, obj.params.depth];
    }
    case 'helix': {
      const sk = findSketch(model, obj.helix.sketch);
      const p = sk ? resolveProfile(sk, obj.helix.profile) : null;
      if (!p) return [0, 0, 0];
      const b = profileBounds(p);
      const r = b.center[0] + b.width / 2;
      const h = b.height + obj.params.pitch * obj.params.turns;
      const local = extrudeLocalMatrix(model, obj);
      return local ? extrudeLocalSize(local, [2 * r, h, 2 * r]) : [2 * r, h, 2 * r];
    }
    case 'fillet':
    case 'draft': {
      const src = model.objects.find((o) => o.id === (obj.kind === 'fillet' ? obj.fillet.source : obj.draft.source));
      return src ? localSize(src, model) : [0, 0, 0];
    }
    case 'loft':
    case 'sweep':
    case 'mesh':
    case 'step':
      return [0, 0, 0]; // 크기는 엔진 메시로 (질량 특성·출력 검사)
  }
}

export function extrudeProfile(obj: Extract<CadObject, { kind: 'extrude' }>, model: ModelDefinition) {
  const sketch = findSketch(model, obj.extrude.sketch);
  return sketch ? profileOf(sketch, obj.extrude) : null;
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
      if (p.type === 'circle') return `Ø${formatMm(p.diameter)}×${d}`;
      if (p.type === 'slot') return `슬롯 ${formatMm(p.length + p.width)}×${formatMm(p.width)}×${d}`;
      if (p.type === 'ellipse') return `타원 ${formatMm(p.width)}×${formatMm(p.height)}×${d}`;
      if (obj.extrude.thin !== undefined) return `리브 t${formatMm(obj.extrude.thin)}×${d}`;
      return `${formatMm(p.width)}×${formatMm(p.height)}×${d}`;
    }
    case 'revolve': {
      const sk = model ? findSketch(model, obj.revolve.sketch) : undefined;
      const p = sk ? resolveProfile(sk, obj.revolve.profile) : null;
      const a = `${formatMm(obj.params.angle)}°`;
      if (!p) return `회전 ${a}`;
      const b = profileBounds(p);
      return `Ø${formatMm(2 * (b.center[0] + b.width / 2))}×${formatMm(b.height)} ${a}`;
    }
    case 'boolean': {
      const n = obj.boolean.tools.length;
      return `${OPERATION_INFO[obj.boolean.operation].symbol} ${n}개`;
    }
    case 'hole': {
      const p = obj.params;
      const extra = p.cboreDiameter > 0 ? ` 카운터보어 Ø${formatMm(p.cboreDiameter)}` : p.csinkDiameter > 0 ? ` 카운터싱크 Ø${formatMm(p.csinkDiameter)}` : '';
      return `Ø${formatMm(p.diameter)}×${formatMm(p.depth)}${extra}`;
    }
    case 'helix':
      return `피치 ${formatMm(obj.params.pitch)} × ${formatMm(obj.params.turns)}바퀴`;
    case 'loft':
      return `단면 ${obj.loft.sections.length}개`;
    case 'sweep':
      return `경로 ${obj.sweep.path}`;
    case 'fillet':
      return `${obj.fillet.type === 'fillet' ? 'R' : 'C'}${formatMm(obj.fillet.size)} ${typeof obj.fillet.edges === 'string' ? EDGE_RULE_LABEL[obj.fillet.edges] : `고른 모서리 ${obj.fillet.edges.at.length}개`}`;
    case 'draft':
      return `${formatMm(obj.draft.angle)}°`;
    case 'step':
      return `STEP ${Math.round((obj.step.data.length * 3) / 4 / 1024).toLocaleString()}KB`;
    case 'mesh':
      return `삼각형 ${Math.round((obj.mesh.indices.length * 3) / 4 / 12).toLocaleString()}개`;
    case 'pattern': {
      const p = obj.pattern;
      if (p.type === 'mirror') return `${p.plane} 평면`;
      if (p.type === 'scale') return p.x === p.y && p.y === p.z ? `×${formatMm(p.x)}` : `×(${[p.x, p.y, p.z].map(formatMm).join(', ')})`;
      if (p.type === 'circular') return `${p.axis.toUpperCase()}축 ${p.count}개 ${formatMm(p.angle)}°`;
      return p.axis2 ? `${p.count}×${p.count2 ?? 1}개` : `${p.axis.toUpperCase()} ${p.count}개 간격 ${formatMm(p.spacing)}`;
    }
  }
}
