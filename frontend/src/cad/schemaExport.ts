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

export function buildSketchPlateFixture(commands: unknown[] = SKETCH_PLATE_COMMANDS) {
  let model = emptyModel();
  for (const cmd of commands) {
    const r = executeCommand(model, cmd);
    if (!r.ok) throw new Error(`픽스처 생성 실패: ${r.error}`);
    model = r.model;
  }
  return model;
}

/** 파일명(shared/schemas 기준 상대 경로) → 내용 */
export function generateSchemas(): Record<string, string> {
  return {
    'examples/model-cut-rotated.json': JSON.stringify(buildBooleanFixture(), null, 2) + '\n',
    'examples/model-sketch-plate.json': JSON.stringify(buildSketchPlateFixture(), null, 2) + '\n',
    'examples/model-sketch-planes.json': JSON.stringify(buildSketchPlateFixture(SKETCH_PLANES_COMMANDS), null, 2) + '\n',
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
