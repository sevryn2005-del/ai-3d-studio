/**
 * CAD 데이터 모델과 명령 스키마.
 *
 * - 모든 길이 단위는 mm, 각도 단위는 degree.
 * - 좌표계: Z-up 오른손 좌표계 (CadQuery/Open CASCADE와 동일). XY 평면이 출력 베드.
 * - 모든 기본 도형의 원점은 "바운딩 박스 바닥면 중심"이다. position.z = 0 이면 베드 위에 놓인다.
 *   (CadQuery: box(..., centered=(True, True, False)), sphere(..., centered=(True, True, False)),
 *    Solid.makeCylinder / makeCone 은 원래 밑면 중심이 원점)
 * - 원통·원뿔의 축은 로컬 Z축이다.
 * - 불리언 객체(합치기/빼기/교차)는 피연산자를 자식으로 참조한다. 자식의 transform 은 부모 좌표계 기준이며,
 *   world = parent ∘ child 로 합성한다 (transformMath.ts).
 *
 * 이 파일의 스키마는 3주 차에 shared/schemas/cad-command.schema.json 으로
 * 내보내 백엔드(Pydantic)와 공유한다. 프론트/백엔드가 같은 계약을 쓰는 것이 원칙.
 */
import { z } from 'zod';

// ---- 범위 제한 (실행 전 검증) -------------------------------------------
export const LIMITS = {
  minDimension: 0.1, // mm
  maxDimension: 1000, // mm
  maxCoordinate: 10_000, // mm
  maxRotation: 360, // deg
  maxObjects: 1000,
  maxBooleanTools: 50,
  maxBooleanDepth: 8,
} as const;

const dimension = z
  .number()
  .min(LIMITS.minDimension, `치수는 ${LIMITS.minDimension}mm 이상이어야 합니다`)
  .max(LIMITS.maxDimension, `치수는 ${LIMITS.maxDimension}mm 이하여야 합니다`);

const radius = z
  .number()
  .min(LIMITS.minDimension / 2, `반지름은 ${LIMITS.minDimension / 2}mm 이상이어야 합니다`)
  .max(LIMITS.maxDimension / 2, `반지름은 ${LIMITS.maxDimension / 2}mm 이하여야 합니다`);

/** 원뿔 꼭짓점처럼 0이 허용되는 반지름 */
const radiusOrZero = z
  .number()
  .min(0, '반지름은 0 이상이어야 합니다')
  .max(LIMITS.maxDimension / 2, `반지름은 ${LIMITS.maxDimension / 2}mm 이하여야 합니다`);

const coordinate = z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate);
const angle = z.number().min(-LIMITS.maxRotation).max(LIMITS.maxRotation);

export const Vec3Schema = z.tuple([coordinate, coordinate, coordinate]);
export const RotationSchema = z.tuple([angle, angle, angle]);
export type Vec3 = z.infer<typeof Vec3Schema>;

export const ObjectIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}$/, '객체 ID는 소문자/숫자/밑줄만 사용할 수 있습니다');
export type ObjectId = z.infer<typeof ObjectIdSchema>;

/** 표시 이름: 1–100자, 공백 외 글자 1개 이상 (JSON Schema 에도 pattern 으로 표현됨) */
const NameSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(/\S/, '이름에는 공백이 아닌 글자가 하나 이상 필요합니다');

// ---- 설계 원본 (ModelDefinition) -----------------------------------------
export const BoxParamsSchema = z.strictObject({
  width: dimension, // X
  depth: dimension, // Y
  height: dimension, // Z
});

export const CylinderParamsSchema = z.strictObject({
  radius,
  height: dimension,
});

export const SphereParamsSchema = z.strictObject({
  radius,
});

export const ConeParamsSchema = z
  .strictObject({
    radiusBottom: radiusOrZero,
    radiusTop: radiusOrZero,
    height: dimension,
  })
  .refine((p) => Math.max(p.radiusBottom, p.radiusTop) >= LIMITS.minDimension / 2, {
    message: '원뿔의 위·아래 반지름 중 하나는 0보다 커야 합니다',
  });

/** 도형 종류별 파라미터 스키마. 새 도형은 여기와 CadObjectSchema 에 추가한다. */
export const PARAMS_SCHEMAS = {
  box: BoxParamsSchema,
  cylinder: CylinderParamsSchema,
  sphere: SphereParamsSchema,
  cone: ConeParamsSchema,
} as const;

export type PrimitiveKind = keyof typeof PARAMS_SCHEMAS;
export type ObjectKind = PrimitiveKind | 'boolean';
export const PRIMITIVE_KINDS = Object.keys(PARAMS_SCHEMAS) as PrimitiveKind[];
export type BoxParams = z.infer<typeof BoxParamsSchema>;
export type CylinderParams = z.infer<typeof CylinderParamsSchema>;
export type SphereParams = z.infer<typeof SphereParamsSchema>;
export type ConeParams = z.infer<typeof ConeParamsSchema>;

export const TransformSchema = z.strictObject({
  position: Vec3Schema,
  rotation: RotationSchema, // XYZ 오일러, degree
});
export type Transform = z.infer<typeof TransformSchema>;

const objectBase = {
  id: ObjectIdSchema,
  name: NameSchema,
  transform: TransformSchema,
};

export const BooleanOperationSchema = z.enum(['union', 'cut', 'intersect']);
export type BooleanOperation = z.infer<typeof BooleanOperationSchema>;

/** base 에 tools 를 순서대로 적용한다. cut: base − tools, union: base ∪ tools, intersect: base ∩ tools */
export const BooleanDefSchema = z.strictObject({
  operation: BooleanOperationSchema,
  base: ObjectIdSchema,
  tools: z.array(ObjectIdSchema).min(1).max(LIMITS.maxBooleanTools),
});

export const CadObjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...objectBase, kind: z.literal('box'), params: BoxParamsSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('cylinder'), params: CylinderParamsSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('sphere'), params: SphereParamsSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('cone'), params: ConeParamsSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('boolean'), boolean: BooleanDefSchema }),
]);
export type CadObject = z.infer<typeof CadObjectSchema>;
export type CadObjectOf<K extends ObjectKind> = Extract<CadObject, { kind: K }>;
export type PrimitiveObject = Extract<CadObject, { kind: PrimitiveKind }>;
export type BooleanObject = CadObjectOf<'boolean'>;

export const ModelDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(1),
  units: z.literal('mm'),
  objects: z.array(CadObjectSchema).max(LIMITS.maxObjects, `객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`),
});
export type ModelDefinition = z.infer<typeof ModelDefinitionSchema>;

// ---- CAD 명령 ------------------------------------------------------------
const createBase = {
  id: ObjectIdSchema.optional(), // 생략 시 자동 생성
  name: NameSchema.optional(),
  position: Vec3Schema.optional(), // 바닥면 중심 위치, 생략 시 원점
};

export const CreateBoxCommandSchema = z.strictObject({
  type: z.literal('create_box'),
  ...createBase,
  width: dimension,
  depth: dimension,
  height: dimension,
});

export const CreateCylinderCommandSchema = z.strictObject({
  type: z.literal('create_cylinder'),
  ...createBase,
  radius,
  height: dimension,
});

export const CreateSphereCommandSchema = z.strictObject({
  type: z.literal('create_sphere'),
  ...createBase,
  radius,
});

export const CreateConeCommandSchema = z.strictObject({
  type: z.literal('create_cone'),
  ...createBase,
  radiusBottom: radiusOrZero,
  radiusTop: radiusOrZero,
  height: dimension,
});

/**
 * 불리언 연산: base 와 tools 를 자식으로 갖는 새 불리언 객체를 만든다.
 * 피연산자는 삭제되지 않고 보존되어 나중에 치수·위치를 수정할 수 있다 (파라메트릭).
 * base 와 tools 는 다른 불리언에 속하지 않은 최상위 객체여야 한다.
 */
const booleanCommandShape = {
  id: createBase.id,
  name: createBase.name,
  base: ObjectIdSchema,
  tools: z.array(ObjectIdSchema).min(1).max(LIMITS.maxBooleanTools),
};
export const CutCommandSchema = z.strictObject({ type: z.literal('cut'), ...booleanCommandShape });
export const UnionCommandSchema = z.strictObject({ type: z.literal('union'), ...booleanCommandShape });
export const IntersectCommandSchema = z.strictObject({ type: z.literal('intersect'), ...booleanCommandShape });

/**
 * 파라미터 변경. 어떤 키가 허용되는지는 대상 객체의 종류에 따라 실행기가 검사한다.
 * (예: 원통에 width 를 지정하면 거부)
 */
/** set_params 의 params. JSON Schema 로 내보낼 때 minProperties: 1 이 추가된다 (schemaExport.ts). */
export const SetParamsParamsSchema = z
  .strictObject({
    width: dimension,
    depth: dimension,
    height: dimension,
    radius,
    radiusBottom: radiusOrZero,
    radiusTop: radiusOrZero,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: '변경할 파라미터가 하나 이상 필요합니다' });

export const SetParamsCommandSchema = z.strictObject({
  type: z.literal('set_params'),
  target: ObjectIdSchema,
  params: SetParamsParamsSchema,
});

export const TranslateCommandSchema = z.strictObject({
  type: z.literal('translate'),
  target: ObjectIdSchema,
  offset: Vec3Schema, // 상대 이동량 (mm)
});

export const SetTransformCommandSchema = z.strictObject({
  type: z.literal('set_transform'),
  target: ObjectIdSchema,
  position: Vec3Schema.optional(), // 절대 위치
  rotation: RotationSchema.optional(), // 절대 회전
});

export const RenameObjectCommandSchema = z.strictObject({
  type: z.literal('rename_object'),
  target: ObjectIdSchema,
  name: NameSchema.trim(),
});

export const DuplicateObjectCommandSchema = z.strictObject({
  type: z.literal('duplicate_object'),
  target: ObjectIdSchema,
  newId: ObjectIdSchema.optional(),
  offset: Vec3Schema.optional(),
});

export const DeleteObjectCommandSchema = z.strictObject({
  type: z.literal('delete_object'),
  target: ObjectIdSchema,
});

export const CadCommandSchema = z.discriminatedUnion('type', [
  CreateBoxCommandSchema,
  CreateCylinderCommandSchema,
  CreateSphereCommandSchema,
  CreateConeCommandSchema,
  CutCommandSchema,
  UnionCommandSchema,
  IntersectCommandSchema,
  SetParamsCommandSchema,
  TranslateCommandSchema,
  SetTransformCommandSchema,
  RenameObjectCommandSchema,
  DuplicateObjectCommandSchema,
  DeleteObjectCommandSchema,
]);
export type CadCommand = z.infer<typeof CadCommandSchema>;
export type CreateCommand = Extract<CadCommand, { type: `create_${string}` }>;
export type BooleanCommand = Extract<CadCommand, { type: BooleanOperation }>;

export function emptyModel(): ModelDefinition {
  return { schemaVersion: 1, units: 'mm', objects: [] };
}
