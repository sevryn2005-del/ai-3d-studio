/**
 * 참조 형상 (형식 v34, 솔리드웍스 Reference Geometry): 기준 평면·축·점·좌표계 — 형상을 만들지 않는 기준.
 * 세 점 → 평면, 두 점 → 축, 세 점(원점·x 쪽·y 쪽) → 좌표계. 방향은 단위로 맞추고 (소수 6자리), 평면 x 방향은 법선에 수직으로 고친다.
 */
import type { FramePlane, ModelDefinition, Reference, Vec3 } from './commandTypes';
import { MAX_REFERENCES } from './commandTypes';
import { Matrix4, Quaternion, Vector3 } from 'three';
import { fromMatrix, toMatrix } from './transformMath';

export type RefType = Reference['type'];
export const REF_LABEL: Record<RefType, string> = { plane: '기준 평면', axis: '기준 축', point: '기준 점', csys: '좌표계' };
/** 화면에서 고를 점 수 */
export const REF_POINTS: Record<RefType, number> = { plane: 3, axis: 2, point: 1, csys: 3 };
export const REF_POINT_HINT: Record<RefType, string[]> = {
  plane: ['첫 점 (원점)', '둘째 점 (x 방향)', '셋째 점 (평면 위)'],
  axis: ['첫 점', '둘째 점 (방향)'],
  point: ['점'],
  csys: ['원점', 'x 축 위 점', 'xy 평면 위 점 (y 쪽)'],
};

const r6 = (v: number) => Math.round(v * 1e6) / 1e6 + 0;
const sub = (a: Vec3, b: Vec3): Vec3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const cross = (a: Vec3, b: Vec3): Vec3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const dot = (a: Vec3, b: Vec3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const len = (a: Vec3) => Math.hypot(a[0], a[1], a[2]);
const unit = (a: Vec3): Vec3 | null => {
  const l = len(a);
  return l > 1e-9 ? [r6(a[0] / l), r6(a[1] / l), r6(a[2] / l)] : null;
};
/** a 에서 n 성분을 뺀 단위 벡터 (n 은 단위) */
const perp = (a: Vec3, n: Vec3): Vec3 | null => {
  const d = dot(a, n);
  return unit([a[0] - d * n[0], a[1] - d * n[1], a[2] - d * n[2]]);
};

type RefBody = { type: RefType } & Record<string, unknown>;

/** 입력 → 저장할 참조 형상 (방향 정리). 잘못되면 오류 글 */
export function normalizeReference(r: RefBody & { id: string; name: string }): Reference | string {
  const v = (k: string) => r[k] as Vec3;
  switch (r.type) {
    case 'plane': {
      const n = unit(v('normal'));
      if (!n) return '평면 법선이 0입니다 (세 점이 한 줄 위에 있음)';
      const x = perp(v('xDir'), n);
      if (!x) return '평면 x 방향이 법선과 나란합니다';
      return { id: r.id, name: r.name, type: 'plane', origin: v('origin'), normal: n, xDir: x };
    }
    case 'axis': {
      const d = unit(v('direction'));
      if (!d) return '축 방향이 0입니다 (두 점이 같음)';
      return { id: r.id, name: r.name, type: 'axis', origin: v('origin'), direction: d };
    }
    case 'point':
      return { id: r.id, name: r.name, type: 'point', position: v('position') };
    case 'csys': {
      const z = unit(v('zDir'));
      if (!z) return '좌표계 z 방향이 0입니다';
      const x = perp(v('xDir'), z);
      if (!x) return '좌표계 x 방향이 z 와 나란합니다';
      return { id: r.id, name: r.name, type: 'csys', origin: v('origin'), xDir: x, zDir: z };
    }
  }
}

/** 화면에서 고른 점 → add_reference 의 reference 본문 (점이 모자라거나 겹치면 오류 글) */
export function referenceFromPoints(type: RefType, pts: Vec3[]): RefBody | string {
  if (pts.length < REF_POINTS[type]) return `점을 ${REF_POINTS[type]}개 고르세요`;
  const [a, b, c] = pts as [Vec3, Vec3, Vec3];
  switch (type) {
    case 'point':
      return { type, position: a };
    case 'axis':
      return len(sub(b, a)) < 1e-9 ? '두 점이 같습니다' : { type, origin: a, direction: sub(b, a) };
    case 'plane': {
      const n = cross(sub(b, a), sub(c, a));
      return len(n) < 1e-9 ? '세 점이 한 줄 위에 있습니다' : { type, origin: a, normal: n, xDir: sub(b, a) };
    }
    case 'csys': {
      const z = cross(sub(b, a), sub(c, a));
      return len(z) < 1e-9 ? '세 점이 한 줄 위에 있습니다' : { type, origin: a, xDir: sub(b, a), zDir: z };
    }
  }
}

/** 다음 자동 ID·이름 (객체·스케치·참조 ID 를 모두 피한다) */
export function nextReference(model: ModelDefinition, type: RefType): { id: string; name: string } {
  const taken = new Set([...model.objects, ...model.sketches, ...(model.references ?? [])].map((o) => o.id));
  let n = 1;
  while (taken.has(`ref_${type}_${n}`)) n++;
  return { id: `ref_${type}_${n}`, name: `${REF_LABEL[type]} ${n}` };
}

export function referenceIdTaken(model: ModelDefinition, id: string): boolean {
  return [...model.objects, ...model.sketches, ...(model.references ?? [])].some((o) => o.id === id);
}

export { MAX_REFERENCES };

/** 기준 평면 → 스케치 평면 (고정 위치 frame, 만들 때 복사) */
export function planeOfReference(r: Reference & { type: 'plane' }): FramePlane {
  return { type: 'frame', origin: r.origin, normal: r.normal, xDir: r.xDir, offset: 0 };
}

/**
 * 원형 패턴을 기준 축 둘레로 (형식 그대로): 패턴 좌표계를 축에 맞추고(원점 = 축 위 점, 로컬 Z = 축 방향, axis = 'z'),
 * 원본은 월드 위치가 그대로이도록 새 패턴 좌표계 기준 변환으로 바꾼다 — 명령 셋 (한 번에 실행, 실행 취소 1번).
 */
export function alignPatternToAxisCommands(
  pattern: { id: string; transform: { position: Vec3; rotation: Vec3 }; pattern: { type: string } & Record<string, unknown> },
  source: { id: string; transform: { position: Vec3; rotation: Vec3 } },
  axis: Reference & { type: 'axis' },
): unknown[] {
  const z = new Vector3(...axis.direction).normalize();
  const q = new Quaternion().setFromUnitVectors(new Vector3(0, 0, 1), z);
  const frame = new Matrix4().compose(new Vector3(...axis.origin), q, new Vector3(1, 1, 1));
  const parent = fromMatrix(frame);
  // 원본 월드 = 지금 패턴 변환 ∘ 원본 변환 → 새 패턴 기준
  const world = toMatrix(pattern.transform).multiply(toMatrix(source.transform));
  const child = fromMatrix(toMatrix(parent).invert().multiply(world));
  return [
    { type: 'set_transform', target: pattern.id, position: parent.position, rotation: parent.rotation },
    { type: 'set_transform', target: source.id, position: child.position, rotation: child.rotation },
    { type: 'set_pattern', target: pattern.id, pattern: { ...pattern.pattern, axis: 'z' } },
  ];
}
