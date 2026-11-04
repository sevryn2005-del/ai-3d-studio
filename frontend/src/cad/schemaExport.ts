/**
 * Zod 스키마 → JSON Schema (draft 2020-12) 변환.
 *
 * 생성 결과는 shared/schemas/ 에 커밋되며 다음에 사용된다.
 * - 백엔드(Pydantic) 검증 모델의 계약 테스트 기준
 * - LLM 구조화 출력(structured output)의 스키마
 *
 * 주의: .refine() 같은 교차 필드 규칙(예: 원뿔 반지름 중 하나는 0 초과)은
 * JSON Schema 로 표현되지 않는다. 이런 규칙은 description 에 남기고 서버 검증에서 다시 확인한다.
 */
import { z } from 'zod';
import { CadCommandSchema, LIMITS, ModelDefinitionSchema, SetParamsParamsSchema, emptyModel } from './commandTypes';
import { encodeMesh } from './meshData';
import { executeCommand } from './commandExecutor';

const SCHEMA_BASE_URL = 'https://ai-3d-studio.local/schemas/';

const COMMON_NOTES = [
  '단위: 길이 mm, 각도 degree. 좌표계: Z-up 오른손 좌표계.',
  '모든 기본 도형의 원점은 바운딩 박스 바닥면 중심이며, 원통·원뿔의 축은 로컬 Z축이다.',
  `범위: 치수 ${LIMITS.minDimension}–${LIMITS.maxDimension}mm, 좌표 ±${LIMITS.maxCoordinate}mm, 회전 ±${LIMITS.maxRotation}°, 객체 최대 ${LIMITS.maxObjects}개.`,
  'JSON Schema 로 표현되지 않는 추가 규칙(서버에서 검증): 원뿔의 radiusBottom/radiusTop 중 하나는 0.05mm 이상, ' +
    'set_params 의 params 는 대상 도형 종류에 있는 키만 허용, 존재하지 않는 객체 참조 및 중복 ID 거부.',
].join(' ');

function toSchema(schema: z.ZodType, file: string, title: string, description: string): string {
  const json = {
    ...z.toJSONSchema(schema, {
      target: 'draft-2020-12',
      // refine 로 표현한 규칙 중 JSON Schema 로 옮길 수 있는 것은 여기서 옮긴다
      override: (ctx) => {
        if (ctx.zodSchema === SetParamsParamsSchema) ctx.jsonSchema.minProperties = 1;
      },
    }),
    $id: SCHEMA_BASE_URL + file,
    title,
    description: `${description} ${COMMON_NOTES}`,
  };
  return JSON.stringify(json, null, 2) + '\n';
}

/**
 * 프론트엔드 실행기로 만든 실제 모델 (언어 간 계약 픽스처).
 * 45° 회전한 판(plate)에서, 월드 좌표 (60, 0) 위치의 원통(pin)을 빼서 구멍을 뚫는다.
 * 백엔드는 이 파일의 "부모 기준 변환"을 해석해 구멍이 월드 (60, 0) 에 생기는지 검사한다.
 */
export const BOOLEAN_FIXTURE_COMMANDS: unknown[] = [
  { type: 'create_box', id: 'plate', name: '판', width: 40, depth: 20, height: 5, position: [50, 0, 0] },
  { type: 'set_transform', target: 'plate', rotation: [0, 0, 45] },
  { type: 'create_cylinder', id: 'pin', name: '구멍', radius: 3, height: 10, position: [60, 0, -1] },
  { type: 'cut', base: 'plate', tools: ['pin'] },
];

export function buildBooleanFixture() {
  let model = emptyModel();
  for (const cmd of BOOLEAN_FIXTURE_COMMANDS) {
    const r = executeCommand(model, cmd);
    if (!r.ok) throw new Error(`픽스처 생성 실패: ${r.error}`);
    model = r.model;
  }
  return model;
}

/**
 * 스케치 기준 판 (언어 간 계약 픽스처): 60×40 사각형 → 4 mm 돌출 → 폭을 80 으로 수정 → 지름 6 관통 구멍.
 * 백엔드·브라우저 엔진은 이 파일로 판이 80×40×4 이고 구멍이 (18, 0) 에 있는지 검사한다.
 */
export const SKETCH_PLATE_COMMANDS: unknown[] = [
  { type: 'create_sketch', id: 'sk_plate', name: '판 윤곽' },
  { type: 'add_rectangle', sketch: 'sk_plate', id: 'r1', width: 60, height: 40 },
  { type: 'extrude', id: 'plate', name: '기준 판', sketch: 'sk_plate', profile: 'r1', distance: 4 },
  { type: 'set_dimension', sketch: 'sk_plate', dimension: 'r1.width', value: 80 },
  { type: 'create_sketch', id: 'sk_hole', name: '구멍', plane: { type: 'XY', offset: -1 } },
  { type: 'add_circle', sketch: 'sk_hole', id: 'c1', center: [18, 0], diameter: 6 },
  { type: 'extrude', id: 'hole', name: '관통 구멍', sketch: 'sk_hole', profile: 'c1', distance: 6 },
  { type: 'cut', id: 'plate_holed', name: '구멍 뚫린 판', base: 'plate', tools: ['hole'] },
];

/**
 * 세 평면 (언어 간 계약 픽스처). 기대 월드 바운딩 박스 (CadQuery 이름 평면 규약):
 *   front (XZ, offset 3, 30×20 @ (5,10), 4mm):  X −10..20, Y −7..−3, Z 0..20
 *   side  (YZ, offset −2, Ø10 @ (2,8), 6mm):     X −2..4,  Y −3..7,  Z 3..13
 *   front_moved: front 와 같은 스케치, 위치 (0,0,5) · Z 90° 회전
 */
export const SKETCH_PLANES_COMMANDS: unknown[] = [
  { type: 'create_sketch', id: 'sk_front', name: '정면', plane: { type: 'XZ', offset: 3 } },
  { type: 'add_rectangle', sketch: 'sk_front', id: 'r1', center: [5, 10], width: 30, height: 20 },
  { type: 'extrude', id: 'front', sketch: 'sk_front', profile: 'r1', distance: 4 },
  { type: 'create_sketch', id: 'sk_side', name: '측면', plane: { type: 'YZ', offset: -2 } },
  { type: 'add_circle', sketch: 'sk_side', id: 'c1', center: [2, 8], diameter: 10 },
  { type: 'extrude', id: 'side', sketch: 'sk_side', profile: 'c1', distance: 6 },
  { type: 'extrude', id: 'front_moved', sketch: 'sk_front', profile: 'r1', distance: 4, position: [0, 0, 5] },
  { type: 'set_transform', target: 'front_moved', rotation: [0, 0, 90] },
];

/**
 * 면 위 스케치 (언어 간 계약 픽스처, docs/design-face-sketch.md). 판 80×40×4 를 (10,0,0) 에 Z 90° 회전.
 * - boss: 판 윗면(end)의 원 Ø10 @ (5,0) → 6mm 기둥     → 월드 X 5..15, Y 0..10, Z 4..10
 * - pocket: 판 윗면의 사각형 10×6 → −3mm (안쪽) 홈      → 월드 X 7..13, Y −5..5, Z 1..4 (빈 공간)
 * - peg: 판 −u 옆면의 원 Ø6 @ (0,1) → 5mm 돌기          → 월드 X 7..13, Y −45..−40, Z 0..6
 * - part = (판 − 홈) ∪ 기둥 ∪ 돌기. 판이 불리언 안에 있어도 면은 기준 객체로 위임된다.
 * 전체: X −10..30, Y −45..40, Z 0..10, 부피 = 80·40·4 − 10·6·3 + π·25·6 + π·9·5
 */
export const FACE_SKETCH_COMMANDS: unknown[] = [
  { type: 'create_sketch', id: 'sk_plate', name: '판 윤곽' },
  { type: 'add_rectangle', sketch: 'sk_plate', id: 'r1', width: 80, height: 40 },
  { type: 'extrude', id: 'plate', name: '판', sketch: 'sk_plate', profile: 'r1', distance: 4, position: [10, 0, 0] },
  { type: 'set_transform', target: 'plate', rotation: [0, 0, 90] },
  { type: 'create_sketch', id: 'sk_top', name: '윗면', plane: { type: 'face', object: 'plate', face: 'end', offset: 0 } },
  { type: 'add_circle', sketch: 'sk_top', id: 'c1', center: [5, 0], diameter: 10 },
  { type: 'add_rectangle', sketch: 'sk_top', id: 'r1', center: [0, 0], width: 10, height: 6 },
  { type: 'extrude', id: 'boss', name: '기둥', sketch: 'sk_top', profile: 'c1', distance: 6 },
  { type: 'extrude', id: 'pocket', name: '홈', sketch: 'sk_top', profile: 'r1', distance: -3 },
  { type: 'create_sketch', id: 'sk_side', name: '옆면', plane: { type: 'face', object: 'plate', face: '-u', offset: 0 } },
  { type: 'add_circle', sketch: 'sk_side', id: 'c1', center: [0, 1], diameter: 6 },
  { type: 'extrude', id: 'peg', name: '돌기', sketch: 'sk_side', profile: 'c1', distance: 5 },
  { type: 'cut', id: 'plate_cut', name: '홈 판', base: 'plate', tools: ['pocket'] },
  { type: 'union', id: 'part', name: '부품', base: 'plate_cut', tools: ['boss', 'peg'] },
];

/**
 * 구속 해석기 (언어 간 계약 픽스처, docs/review-constraint-solver.md). 대충 그린 6각형을
 * 고정·수평·수직·길이 구속으로 L자 브래킷으로 만든다 → (0,0) (60,0) (60,15) (20,15) (20,40) (0,40), 자유도 0.
 * 구멍 Ø6 @ (40, 7.5) 을 5mm 판에서 뺀다. 부피 = (60·15 + 20·25)·5 − π·9·5.
 * 백엔드는 저장된 좌표가 구속을 만족하는지 같은 잔차 식으로 검사한다 (app/cad/constraints.py).
 */
export const CONSTRAINT_BRACKET_COMMANDS: unknown[] = [
  { type: 'create_sketch', id: 'sk_l', name: 'L 브래킷' },
  { type: 'add_polygon', sketch: 'sk_l', id: 'l', points: [[1, -1], [58, 2], [61, 14], [22, 17], [18, 38], [-2, 41]] },
  { type: 'move_point', sketch: 'sk_l', point: 'l.p0', to: [0, 0] },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'fix', refs: ['l.p0'] },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'horizontal', refs: ['l.e0'] },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'vertical', refs: ['l.e1'] },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'horizontal', refs: ['l.e2'] },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'vertical', refs: ['l.e3'] },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'horizontal', refs: ['l.e4'] },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'vertical', refs: ['l.e5'] },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'length', refs: ['l.e0'], value: 60 },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'length', refs: ['l.e1'], value: 15 },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'length', refs: ['l.e3'], value: 25 },
  { type: 'add_constraint', sketch: 'sk_l', constraint: 'length', refs: ['l.e4'], value: 20 },
  { type: 'extrude', id: 'bracket', name: '브래킷', sketch: 'sk_l', profile: 'l', distance: 5 },
  { type: 'create_sketch', id: 'sk_hole', name: '구멍', plane: { type: 'XY', offset: -1 } },
  { type: 'add_circle', sketch: 'sk_hole', id: 'c1', center: [40, 7.5], diameter: 6 },
  { type: 'extrude', id: 'hole', name: '구멍', sketch: 'sk_hole', profile: 'c1', distance: 7 },
  { type: 'cut', id: 'bracket_holed', name: '구멍 뚫린 브래킷', base: 'bracket', tools: ['hole'] },
];

/**
 * 회전 (언어 간 계약 픽스처). XZ 평면(u = X, v = Z, 법선 −Y) 스케치를 v 축(= 월드 Z) 둘레로 돌린다.
 * - cup: 다각형 단면 (0,0)(30,0)(30,40)(27,40)(27,3)(0,3) 360° → 바깥 Ø60×40, 벽·바닥 3mm. 부피 π·(30²·3 + (30²−27²)·37)
 * - ring: 사각형 u 10..20, v 0..5 를 90° → +u 가 −w(= 월드 +Y) 쪽으로 → 위치 (80,0,0) 에서 월드 X 80..100, Y 0..20, Z 0..5. 부피 π·(20²−10²)·5/4
 */
export const REVOLVE_COMMANDS: unknown[] = [
  { type: 'create_sketch', id: 'sk_cup', name: '컵 단면', plane: { type: 'XZ', offset: 0 } },
  { type: 'add_polygon', sketch: 'sk_cup', id: 'p1', points: [[0, 0], [30, 0], [30, 40], [27, 40], [27, 3], [0, 3]] },
  { type: 'revolve', id: 'cup', name: '컵', sketch: 'sk_cup', profile: 'p1' },
  { type: 'create_sketch', id: 'sk_ring', name: '고리 단면', plane: { type: 'XZ', offset: 0 } },
  { type: 'add_rectangle', sketch: 'sk_ring', id: 'r1', center: [15, 2.5], width: 10, height: 5 },
  { type: 'revolve', id: 'ring', name: '1/4 고리', sketch: 'sk_ring', profile: 'r1', angle: 90, position: [80, 0, 0] },
];

export function buildSketchPlateFixture(commands: unknown[] = SKETCH_PLATE_COMMANDS) {
  let model = emptyModel();
  for (const cmd of commands) {
    const r = executeCommand(model, cmd);
    if (!r.ok) throw new Error(`픽스처 생성 실패: ${r.error}`);
    model = r.model;
  }
  return model;
}

/**
 * 다른 CAD 에서 보고된 형상 실패 사례 (docs/issue-survey.md 4-3·4-5·7-3·7-4). 두 엔진 모두
 * 닫힌 메시·양의 부피·같은 부피여야 한다: 브라우저 issueSurvey.test.ts, 서버 test_issue_survey.py
 */
export const SURVEY_CASES: Record<string, { volume: number; commands: unknown[] }> = {
  'touching-faces-union': {
    volume: 2000,
    commands: [
      { type: 'create_box', id: 'a', width: 10, depth: 10, height: 10 },
      { type: 'create_box', id: 'b', width: 10, depth: 10, height: 10, position: [10, 0, 0] },
      { type: 'union', id: 'u', base: 'a', tools: ['b'] },
    ],
  },
  'coplanar-through-cut': {
    volume: 4000 - Math.PI * 9 * 10,
    commands: [
      { type: 'create_box', id: 'a', width: 20, depth: 20, height: 10 },
      { type: 'create_cylinder', id: 'c', radius: 3, height: 10 },
      { type: 'cut', id: 'k', base: 'a', tools: ['c'] },
    ],
  },
  'tangent-side-cut': {
    volume: 4000,
    commands: [
      { type: 'create_box', id: 'a', width: 20, depth: 20, height: 10 },
      { type: 'create_cylinder', id: 'c', radius: 3, height: 20, position: [13, 0, -5] },
      { type: 'cut', id: 'k', base: 'a', tools: ['c'] },
    ],
  },
  'revolve-and-negative-extrude': {
    volume: Math.PI * (13 * 13 - 7 * 7) * 10 + 500,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XZ', offset: 0 } },
      { type: 'add_rectangle', sketch: 's', id: 'r', center: [10, 5], width: 6, height: 10 },
      { type: 'revolve', id: 'v', sketch: 's', profile: 'r', angle: 360 },
      { type: 'create_sketch', id: 't', plane: { type: 'XY', offset: 0 } },
      { type: 'add_rectangle', sketch: 't', id: 'q', center: [40, 0], width: 10, height: 10 },
      { type: 'extrude', id: 'e', sketch: 't', profile: 'q', distance: -5 },
    ],
  },
  'revolve-edge-on-axis': {
    volume: Math.PI * 100 * 10,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_rectangle', sketch: 's', id: 'y', center: [5, 5], width: 10, height: 10 },
      { type: 'revolve', id: 'v', sketch: 's', profile: 'y', angle: 360 },
    ],
  },
  'revolve-cone-point-on-axis': {
    volume: (Math.PI * 100 * 10) / 3,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_polygon', sketch: 's', id: 't', points: [[0, 0], [10, 0], [0, 10]] },
      { type: 'revolve', id: 'v', sketch: 's', profile: 't', angle: 360 },
    ],
  },
};

const PI = Math.PI;

/** 가져오기 시험용 정육면체 메시 (바닥면 중심 원점, 바깥 법선) */
function cubeMesh(a: number) {
  const h = a / 2;
  const v = [[-h, -h, 0], [h, -h, 0], [h, h, 0], [-h, h, 0], [-h, -h, a], [h, -h, a], [h, h, a], [-h, h, a]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  return encodeMesh({ positions: Float32Array.from(v.flat()), indices: Uint32Array.from(f.flat()) });
}
const box = (id: string, w: number, d: number, h: number, position?: number[]) => ({ type: 'create_box', id, width: w, depth: d, height: h, ...(position ? { position } : {}) });
/**
 * 형식 v6 피처 (쉘·구멍·패턴·대칭·억제). 두 엔진 모두 닫힌 메시·같은 부피(해석값)여야 한다:
 * 브라우저 features.test.ts, 서버 test_features.py. roots = 계산되는(억제 안 된) 최상위 객체 수
 */
export const FEATURE_CASES: Record<string, { volume: number | 'polygon'; roots: number; commands: unknown[]; bbox?: number[][] }> = {
  'shell-box-open-top': { volume: 24000 - 36 * 26 * 18, roots: 1, commands: [box('b', 40, 30, 20), { type: 'shell', target: 'b', thickness: 2, open: ['top'] }] },
  'shell-box-closed': { volume: 24000 - 36 * 26 * 16, roots: 1, commands: [box('b', 40, 30, 20), { type: 'shell', target: 'b', thickness: 2 }] },
  'shell-box-two-sides': { volume: 24000 - 40 * 26 * 16, roots: 1, commands: [box('b', 40, 30, 20), { type: 'shell', target: 'b', thickness: 2, open: ['+X', '-X'] }] },
  'shell-cylinder-cup': {
    volume: PI * (100 * 20 - 64 * 18),
    roots: 1,
    commands: [{ type: 'create_cylinder', id: 'c', radius: 10, height: 20 }, { type: 'shell', target: 'c', thickness: 2, open: ['top'] }],
  },
  'shell-extrude-l': {
    volume: 500 * 10 - (26 * 6 + 6 * 20) * 8,
    roots: 1,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_polygon', sketch: 's', id: 'p', points: [[0, 0], [30, 0], [30, 10], [10, 10], [10, 30], [0, 30]] },
      { type: 'extrude', id: 'e', sketch: 's', profile: 'p', distance: 10 },
      { type: 'shell', target: 'e', thickness: 2, open: ['end'] },
    ],
  },
  'shell-extrude-negative': {
    volume: 6000 - 26 * 16 * 8,
    roots: 1,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_rectangle', sketch: 's', id: 'r', center: [0, 0], width: 30, height: 20 },
      { type: 'extrude', id: 'e', sketch: 's', profile: 'r', distance: -10 },
      { type: 'shell', target: 'e', thickness: 2, open: ['end'] },
    ],
  },
  'hole-simple-twice': {
    volume: 16000 - 2 * PI * 9 * 10,
    roots: 1,
    commands: [
      box('b', 40, 40, 10),
      { type: 'hole', id: 'h1', target: 'b', face: 'top', at: [-10, 0], diameter: 6, depth: 10 },
      { type: 'hole', id: 'h2', target: 'cut_1', face: 'top', at: [10, 0], diameter: 6, depth: 10 },
    ],
  },
  'hole-counterbore': {
    volume: 16000 - (PI * 9 * 6 + PI * 30.25 * 4),
    roots: 1,
    commands: [box('b', 40, 40, 10), { type: 'hole', target: 'b', face: 'top', at: [0, 0], diameter: 6, depth: 10, cboreDiameter: 11, cboreDepth: 4 }],
  },
  'hole-countersink-side': {
    volume: 16000 - (PI * 9 * 7 + PI * 63),
    roots: 1,
    commands: [box('b', 40, 40, 10), { type: 'hole', target: 'b', face: '+X', at: [0, 0], diameter: 6, depth: 10, csinkDiameter: 12 }],
  },
  'pattern-linear-2d': {
    volume: 6 * 1000,
    roots: 1,
    commands: [box('b', 10, 10, 10), { type: 'pattern', pattern: { type: 'linear', source: 'b', axis: 'x', count: 3, spacing: 20, axis2: 'y', count2: 2, spacing2: 20 } }],
  },
  'pattern-linear-overlap': {
    volume: 10 * 10 * 20,
    roots: 1,
    commands: [box('b', 10, 10, 10), { type: 'pattern', pattern: { type: 'linear', source: 'b', axis: 'x', count: 3, spacing: 5 } }],
  },
  'pattern-circular': {
    volume: 6 * PI * 36 * 5,
    roots: 1,
    commands: [
      { type: 'create_cylinder', id: 'c', radius: 6, height: 5, position: [30, 0, 0] },
      { type: 'pattern', pattern: { type: 'circular', source: 'c', axis: 'z', count: 6, angle: 360 } },
    ],
  },
  'mirror-offset-touching': {
    volume: 2000,
    roots: 1,
    commands: [box('b', 10, 10, 10, [5, 0, 0]), { type: 'pattern', pattern: { type: 'mirror', source: 'b', plane: 'YZ', offset: 10 } }],
  },
  'mirror-of-hole-plate': {
    volume: 2 * (16000 - PI * 9 * 10),
    roots: 1,
    commands: [
      box('b', 40, 40, 10, [30, 0, 0]),
      { type: 'hole', target: 'b', face: 'top', at: [5, 5], diameter: 6, depth: 10 },
      { type: 'pattern', pattern: { type: 'mirror', source: 'cut_1', plane: 'YZ', offset: 0 } },
    ],
  },
  // ---- 형식 v7 ----
  'slot-extrude': {
    volume: (20 * 8 + PI * 16) * 5,
    roots: 1,
    bbox: [[-14, -4, 0], [14, 4, 5]],
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_slot', sketch: 's', id: 'sl', center: [0, 0], length: 20, width: 8 },
      { type: 'extrude', id: 'e', sketch: 's', profile: 'sl', distance: 5 },
    ],
  },
  'slot-revolve-pappus': {
    // 파푸스 정리: 부피 = 2π × (도심까지 거리 30) × 단면 넓이
    volume: 2 * PI * 30 * (20 * 8 + PI * 16),
    roots: 1,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XZ', offset: 0 } },
      { type: 'add_slot', sketch: 's', id: 'sl', center: [30, 0], length: 20, width: 8, angle: 90 },
      { type: 'revolve', id: 'v', sketch: 's', profile: 'sl', angle: 360 },
    ],
  },
  'angled-plane-extrude': {
    volume: 1000,
    roots: 1,
    // XY 를 u(X) 축 둘레 30°: (u, v, w) → (u, v·cos30 − w·sin30, v·sin30 + w·cos30)
    bbox: [[-5, -5 * Math.cos(PI / 6) - 10 * 0.5, -2.5], [5, 5 * Math.cos(PI / 6), 2.5 + 10 * Math.cos(PI / 6)]],
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'angled', base: 'XY', axis: 'u', angle: 30, offset: 0 } },
      { type: 'add_rectangle', sketch: 's', id: 'r', center: [0, 0], width: 10, height: 10 },
      { type: 'extrude', id: 'e', sketch: 's', profile: 'r', distance: 10 },
    ],
  },
  'scale-nonuniform': {
    volume: 1000,
    roots: 1,
    bbox: [[-10, -5, 0], [10, 5, 5]],
    commands: [box('b', 10, 10, 10), { type: 'pattern', pattern: { type: 'scale', source: 'b', x: 2, y: 1, z: 0.5 } }],
  },
  'angle-constraint-triangle': {
    volume: 'polygon',
    roots: 1,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_polygon', sketch: 's', id: 't', points: [[0, 0], [20, 0], [5, 15]] },
      { type: 'add_line', sketch: 's', id: 'ref', points: [[0, -5], [20, -5]] },
      { type: 'add_constraint', sketch: 's', constraint: 'fix', refs: ['t.p0'] },
      { type: 'add_constraint', sketch: 's', constraint: 'parallel', refs: ['t.e0', 'ref.e0'] },
      { type: 'add_constraint', sketch: 's', constraint: 'length', refs: ['t.e0'], value: 20 },
      { type: 'add_constraint', sketch: 's', constraint: 'angle', refs: ['ref.e0', 't.e2'], value: 60 },
      { type: 'extrude', id: 'e', sketch: 's', profile: 't', distance: 4 },
    ],
  },
  // ---- 형식 v8 ----
  'loft-square-frustum': {
    volume: (20 / 3) * (400 + 100 + 200), // 각뿔대: h/3 (A1 + A2 + √(A1·A2))
    roots: 1,
    bbox: [[-10, -10, 0], [10, 10, 20]],
    commands: [
      { type: 'create_sketch', id: 'a', plane: { type: 'XY', offset: 0 } },
      { type: 'add_rectangle', sketch: 'a', id: 'r', width: 20, height: 20 },
      { type: 'create_sketch', id: 'b', plane: { type: 'XY', offset: 20 } },
      { type: 'add_rectangle', sketch: 'b', id: 'r', width: 10, height: 10 },
      { type: 'loft', id: 'l', sections: [{ sketch: 'a', profile: 'r' }, { sketch: 'b', profile: 'r' }] },
    ],
  },
  'loft-circle-three-sections': {
    volume: PI * 100 * 15 + (PI * 15 / 3) * (100 + 25 + 50), // 원기둥 15 + 원뿔대 15
    roots: 1,
    commands: [
      { type: 'create_sketch', id: 'a', plane: { type: 'XY', offset: 0 } },
      { type: 'add_circle', sketch: 'a', id: 'c', diameter: 20 },
      { type: 'create_sketch', id: 'b', plane: { type: 'XY', offset: 15 } },
      { type: 'add_circle', sketch: 'b', id: 'c', diameter: 20 },
      { type: 'create_sketch', id: 'd', plane: { type: 'XY', offset: 30 } },
      { type: 'add_circle', sketch: 'd', id: 'c', diameter: 10 },
      { type: 'loft', id: 'l', sections: [{ sketch: 'a', profile: 'c' }, { sketch: 'b', profile: 'c' }, { sketch: 'd', profile: 'c' }] },
    ],
  },
  'helix-spring': {
    volume: 8 * 2 * PI * 10 * 3, // 나선 운동 부피 = 단면 넓이 × 2π × 도심 반지름 × 바퀴 수
    roots: 1,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XZ', offset: 0 } },
      { type: 'add_rectangle', sketch: 's', id: 'r', center: [10, 0], width: 4, height: 2 },
      { type: 'helix', id: 'h', sketch: 's', profile: 'r', pitch: 5, turns: 3 },
    ],
  },
  'mesh-import-cube': {
    volume: 1000,
    roots: 1,
    bbox: [[-5, -5, 0], [5, 5, 10]],
    commands: [{ type: 'import_mesh', id: 'm', ...cubeMesh(10) }],
  },
  'offset-polygon-and-slot': {
    volume: 24 * 24 * 5 + (10 * 4 + PI * 4) * 5,
    roots: 2,
    commands: [
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_polygon', sketch: 's', id: 'p', points: [[-10, -10], [10, -10], [10, 10], [-10, 10]] },
      { type: 'offset_entity', sketch: 's', entity: 'p', id: 'q', distance: 2 },
      { type: 'extrude', id: 'e', sketch: 's', profile: 'q', distance: 5 },
      { type: 'create_sketch', id: 't', plane: { type: 'XY', offset: 0 } },
      { type: 'add_slot', sketch: 't', id: 'sl', center: [40, 0], length: 10, width: 6 },
      { type: 'offset_entity', sketch: 't', entity: 'sl', id: 'sm', distance: -1 },
      { type: 'extrude', id: 'f', sketch: 't', profile: 'sm', distance: 5 },
    ],
  },
  'suppressed-tool-and-root': {
    volume: 16000,
    roots: 1,
    commands: [
      box('b', 40, 40, 10),
      { type: 'hole', id: 'h1', target: 'b', face: 'top', at: [0, 0], diameter: 6, depth: 10 },
      { type: 'set_suppressed', target: 'h1', suppressed: true },
      box('x', 10, 10, 10, [100, 0, 0]),
      { type: 'set_suppressed', target: 'x', suppressed: true },
      { type: 'set_appearance', target: 'b', color: '#e5534b', hidden: true },
    ],
  },
};

/** 시험용 실제 파일 (scripts/schemaPaths.readSamples) */
export interface FixtureSamples {
  blockHoleStep: string; // base64. CadQuery 로 만든 10×20×30 블록(모서리 (100,50,5)) − 지름 4 관통 구멍
}

/** 둥근 상자 부피: 안쪽 상자를 반지름 r 구로 민코프스키 합 */
const roundedBox = (a: number, b: number, c: number, r: number) => {
  const [x, y, z] = [a - 2 * r, b - 2 * r, c - 2 * r];
  return x * y * z + 2 * r * (x * y + y * z + z * x) + PI * r * r * (x + y + z) + (4 / 3) * PI * r ** 3;
};
/** 원통 위 모서리 필렛으로 빠지는 부피: (r²(1−π/4)) × 2π × 도심 반지름 (파푸스) */
const cylinderTopFilletLoss = (R: number, r: number) => {
  const area = r * r * (1 - PI / 4);
  const d = (r * (10 - 3 * PI)) / (3 * (4 - PI)); // 모서리에서 도심까지
  return area * 2 * PI * (R - d);
};
const frustum = (a1: number, a2: number, h: number) => (h / 3) * (a1 + a2 + Math.sqrt(a1 * a2));

/** 형식 v9 정밀 피처: 브라우저는 OCCT 엔진(occtGeometry.test.ts), 서버는 CadQuery 가 같은 값을 내야 한다 */
export function preciseCases(samples: FixtureSamples): typeof FEATURE_CASES {
  const top = 20 - 2 * 10 * Math.tan((5 * PI) / 180);
  return {
    'fillet-box-all': { volume: roundedBox(20, 20, 20, 2), roots: 1, bbox: [[-10, -10, 0], [10, 10, 20]], commands: [box('b', 20, 20, 20), { type: 'edge_feature', id: 'f', target: 'b', feature: 'fillet', size: 2, edges: 'all' }] },
    'chamfer-box-top': { volume: 20 * 20 * 8 + frustum(400, 256, 2), roots: 1, commands: [box('b', 20, 20, 10), { type: 'edge_feature', id: 'f', target: 'b', feature: 'chamfer', size: 2, edges: 'top' }] },
    'fillet-box-vertical': { volume: 4000 - 4 * (9 - (PI * 9) / 4) * 10, roots: 1, commands: [box('b', 20, 20, 10), { type: 'edge_feature', id: 'f', target: 'b', feature: 'fillet', size: 3, edges: 'vertical' }] },
    'fillet-cylinder-top': { volume: PI * 100 * 10 - cylinderTopFilletLoss(10, 2), roots: 1, commands: [{ type: 'create_cylinder', id: 'c', radius: 10, height: 10 }, { type: 'edge_feature', id: 'f', target: 'c', feature: 'fillet', size: 2, edges: 'top' }] },
    'fillet-moved-boolean-bottom': {
      // 원본이 옮겨져 있어도 규칙은 피처 좌표계(월드)에서 고른다. 바닥 모서리 = 바깥 네 모서리 + 구멍 아래 원
      // (구멍 입구 모따기: 삼각형 넓이 2 × 2π × 도심 반지름 (2 + 2/3))
      volume: 20 * 20 * 8 + frustum(256, 400, 2) - PI * 4 * 10 - 2 * 2 * PI * (2 + 2 / 3),
      roots: 1,
      bbox: [[40, -10, 0], [60, 10, 10]],
      commands: [
        box('b', 20, 20, 10, [50, 0, 0]),
        { type: 'hole', id: 'h', target: 'b', face: 'top', at: [0, 0], diameter: 4, depth: 10 },
        { type: 'edge_feature', id: 'f', target: 'cut_1', feature: 'chamfer', size: 2, edges: 'bottom' },
      ],
    },
    'draft-box': { volume: frustum(400, top * top, 10), roots: 1, bbox: [[-10, -10, 0], [10, 10, 10]], commands: [box('b', 20, 20, 10), { type: 'draft', id: 'd', target: 'b', angle: 5 }] },
    'step-import-block': {
      volume: 6000 - PI * 4 * 30,
      roots: 1,
      bbox: [[-5, -10, 0], [5, 10, 30]],
      commands: [{ type: 'import_step', id: 's', name: '블록', data: samples.blockHoleStep }],
    },
  };
}

export function buildFeatureFixture(samples: FixtureSamples) {
  return Object.fromEntries(
    Object.entries({ ...FEATURE_CASES, ...preciseCases(samples) }).map(([name, c]) => {
      const model = buildSketchPlateFixture(c.commands);
      // 'polygon': 구속으로 풀린 다각형 넓이 × 돌출 거리 (첫 다각형·첫 돌출)
      let volume = c.volume;
      if (volume === 'polygon') {
        const poly = model.sketches.flatMap((s) => s.entities).find((e) => e.type === 'polygon') as { points: number[][] };
        const ext = model.objects.find((o) => o.kind === 'extrude') as { params: { distance: number } };
        const area = Math.abs(poly.points.reduce((a, p, i) => { const q = poly.points[(i + 1) % poly.points.length]!; return a + p[0]! * q[1]! - q[0]! * p[1]!; }, 0)) / 2;
        volume = area * Math.abs(ext.params.distance);
      }
      return [name, { volume, roots: c.roots, ...(c.bbox ? { bbox: c.bbox } : {}), model }];
    }),
  );
}

export function buildSurveyFixture() {
  return Object.fromEntries(
    Object.entries(SURVEY_CASES).map(([name, c]) => [name, { volume: c.volume, model: buildSketchPlateFixture(c.commands) }]),
  );
}

/** 파일명(shared/schemas 기준 상대 경로) → 내용 */
export function generateSchemas(samples: FixtureSamples): Record<string, string> {
  return {
    'examples/model-cut-rotated.json': JSON.stringify(buildBooleanFixture(), null, 2) + '\n',
    'examples/model-sketch-plate.json': JSON.stringify(buildSketchPlateFixture(), null, 2) + '\n',
    'examples/model-sketch-planes.json': JSON.stringify(buildSketchPlateFixture(SKETCH_PLANES_COMMANDS), null, 2) + '\n',
    'examples/model-face-sketch.json': JSON.stringify(buildSketchPlateFixture(FACE_SKETCH_COMMANDS), null, 2) + '\n',
    'examples/model-constraint-bracket.json': JSON.stringify(buildSketchPlateFixture(CONSTRAINT_BRACKET_COMMANDS), null, 2) + '\n',
    'examples/model-revolve.json': JSON.stringify(buildSketchPlateFixture(REVOLVE_COMMANDS), null, 2) + '\n',
    'examples/survey-cases.json': JSON.stringify(buildSurveyFixture(), null, 2) + '\n',
    'examples/feature-cases.json': JSON.stringify(buildFeatureFixture(samples), null, 2) + '\n',
    'cad-command.schema.json': toSchema(
      CadCommandSchema,
      'cad-command.schema.json',
      'CadCommand',
      'AI 와 사용자 UI 가 공통으로 사용하는 CAD 명령. 이 형식 이외의 명령은 실행되지 않는다.',
    ),
    'model-definition.schema.json': toSchema(
      ModelDefinitionSchema,
      'model-definition.schema.json',
      'ModelDefinition',
      '설계 원본(프로젝트 파일에 저장되는 객체·파라미터·변환).',
    ),
  };
}
