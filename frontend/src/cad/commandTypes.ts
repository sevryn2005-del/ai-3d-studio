/**
 * CAD 데이터 모델과 명령 스키마.
 *
 * - 모든 길이 단위는 mm, 각도 단위는 degree.
 * - 좌표계: Z-up 오른손 좌표계 (CadQuery/Open CASCADE와 동일). XY 평면이 출력 베드.
 * - 모든 기본 도형의 원점은 "바운딩 박스 바닥면 중심"이다. position.z = 0 이면 베드 위에 놓인다.
 *   (CadQuery: box(..., centered=(True, True, False)), sphere(..., centered=(True, True, False)),
 *    Solid.makeCylinder / makeCone 은 원래 밑면 중심이 원점)
 * - 원통·원뿔의 축은 로컬 Z축이다.
 * - 스케치(형식 v2)는 객체와 별도 원본(model.sketches). 돌출 객체가 스케치의 프로파일(사각형·원)을 참조하며,
 *   치수를 바꾸면 돌출이 다시 계산된다. 돌출 객체의 로컬 원점 = 스케치 평면의 원점, 방향 = 로컬 +Z.
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
  maxSketches: 200,
  maxSketchEntities: 100,
  maxPolygonPoints: 64,
  maxSketchConstraints: 300,
} as const;

const dimension = z
  .number()
  .min(LIMITS.minDimension, `치수는 ${LIMITS.minDimension}mm 이상이어야 합니다`)
  .max(LIMITS.maxDimension, `치수는 ${LIMITS.maxDimension}mm 이하여야 합니다`);

const radius = z
  .number()
  .min(LIMITS.minDimension / 2, `반지름은 ${LIMITS.minDimension / 2}mm 이상이어야 합니다`)
  .max(LIMITS.maxDimension / 2, `반지름은 ${LIMITS.maxDimension / 2}mm 이하여야 합니다`);

/**
 * 돌출 거리: 양수 = 평면 법선 방향, 음수 = 반대 방향 (면 위 스케치에서 안쪽으로 파내기·구멍).
 * 크기는 일반 치수와 같은 범위.
 */
const extrudeDistance = z.union([
  z.number().min(LIMITS.minDimension).max(LIMITS.maxDimension),
  z.number().min(-LIMITS.maxDimension).max(-LIMITS.minDimension),
], { error: `돌출 거리는 ${LIMITS.minDimension}~${LIMITS.maxDimension}mm (반대 방향은 음수) 여야 합니다` });

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

/** 돌출 객체의 파라미터: 돌출 거리(음수 = 반대 방향). 단면은 참조한 스케치 프로파일이 정한다 */
export const ExtrudeParamsSchema = z.strictObject({
  distance: extrudeDistance,
});

/** 도형 종류별 파라미터 스키마. 새 도형은 여기와 CadObjectSchema 에 추가한다. */
export const PARAMS_SCHEMAS = {
  box: BoxParamsSchema,
  cylinder: CylinderParamsSchema,
  sphere: SphereParamsSchema,
  cone: ConeParamsSchema,
  extrude: ExtrudeParamsSchema,
} as const;

export type PrimitiveKind = keyof typeof PARAMS_SCHEMAS;
export type ObjectKind = PrimitiveKind | 'boolean';
export const PRIMITIVE_KINDS = Object.keys(PARAMS_SCHEMAS) as PrimitiveKind[];
export type BoxParams = z.infer<typeof BoxParamsSchema>;
export type CylinderParams = z.infer<typeof CylinderParamsSchema>;
export type SphereParams = z.infer<typeof SphereParamsSchema>;
export type ConeParams = z.infer<typeof ConeParamsSchema>;

// ---- 스케치 (형식 v2) ----------------------------------------------------------
export const Point2Schema = z.tuple([coordinate, coordinate]);
export type Point2 = z.infer<typeof Point2Schema>;

export const SketchEntitySchema = z.discriminatedUnion('type', [
  z.strictObject({ id: ObjectIdSchema, type: z.literal('rectangle'), center: Point2Schema }),
  z.strictObject({ id: ObjectIdSchema, type: z.literal('circle'), center: Point2Schema }),
  /**
   * 닫힌 다각형 (형식 v4). 꼭짓점 좌표는 구속 해석기가 푼 값을 저장한다 → CAD 엔진은 좌표만 읽는다.
   * 꼭짓점 k = `ID.pk`, 변 k = `ID.ek` (pk → p(k+1), 마지막 변은 처음으로 닫힌다)
   */
  z.strictObject({
    id: ObjectIdSchema,
    type: z.literal('polygon'),
    points: z.array(Point2Schema).min(3).max(LIMITS.maxPolygonPoints),
  }),
]);
export type SketchEntity = z.infer<typeof SketchEntitySchema>;

export const DimensionKindSchema = z.enum(['width', 'height', 'diameter']);
export type DimensionKind = z.infer<typeof DimensionKindSchema>;
/** 치수 ID = `요소ID.종류` (예: r1.width) */
export const DimensionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}\.(width|height|diameter)$/, '치수 ID 는 "요소ID.width|height|diameter" 형식입니다');

export const SketchDimensionSchema = z.strictObject({
  id: DimensionIdSchema,
  entity: ObjectIdSchema,
  kind: DimensionKindSchema,
  value: dimension,
});
export type SketchDimension = z.infer<typeof SketchDimensionSchema>;

/**
 * 기준 평면 (CadQuery 이름 평면과 같은 규약). offset = 평면 법선 방향 거리 (mm).
 * XY: u=X, v=Y, 법선 +Z · XZ: u=X, v=Z, 법선 −Y · YZ: u=Y, v=Z, 법선 +X
 */
export const SketchPlaneTypeSchema = z.enum(['XY', 'XZ', 'YZ']);
export const StandardPlaneSchema = z.strictObject({ type: SketchPlaneTypeSchema, offset: coordinate });

/**
 * 면 이름 (docs/design-face-sketch.md 4.1). 면 번호가 아니라 피처 정의로 정한 이름이라
 * 필렛·구멍·치수 변경 뒤에도 같은 면을 가리킨다.
 * 박스: top bottom +X -X +Y -Y · 원통·원뿔: top bottom · 돌출: start end (+ 사각형 단면은 +u -u +v -v)
 */
export const FaceNameSchema = z.enum(['top', 'bottom', '+X', '-X', '+Y', '-Y', 'start', 'end', '+u', '-u', '+v', '-v']);
export type FaceName = z.infer<typeof FaceNameSchema>;

/** 객체의 이름 있는 면에 붙는 평면. offset = 그 면의 바깥 법선 방향 거리. 객체가 움직이면 따라간다 */
export const FacePlaneSchema = z.strictObject({
  type: z.literal('face'),
  object: ObjectIdSchema,
  face: FaceNameSchema,
  offset: coordinate,
});

export const SketchPlaneSchema = z.discriminatedUnion('type', [
  StandardPlaneSchema,
  FacePlaneSchema,
]);
export type SketchPlane = z.infer<typeof SketchPlaneSchema>;
export type StandardPlane = z.infer<typeof StandardPlaneSchema>;
export type FacePlane = z.infer<typeof FacePlaneSchema>;

/**
 * 기하 구속 (docs/review-constraint-solver.md 5장 1단계). 참조:
 * - 점: 다각형 꼭짓점 `poly.p0`, 사각형·원의 중심 `c1.center`
 * - 변: 다각형 변 `poly.e0` · 원: 원 ID `c1` (접선)
 * value: length·distance 의 길이(mm). fix 는 value 없이 현재 위치에 고정.
 */
export const ConstraintTypeSchema = z.enum([
  'fix', 'coincident', 'concentric', 'horizontal', 'vertical', 'parallel', 'perpendicular', 'equal', 'length', 'distance', 'tangent',
]);
export type ConstraintType = z.infer<typeof ConstraintTypeSchema>;
export const GeomRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}(\.(p|e)\d{1,2}|\.center)?$/, '참조는 "요소ID", "요소ID.center", "다각형ID.p0", "다각형ID.e0" 형식입니다');
export const SketchConstraintSchema = z.strictObject({
  id: ObjectIdSchema,
  type: ConstraintTypeSchema,
  refs: z.array(GeomRefSchema).min(1).max(2),
  value: dimension.optional(),
});
export type SketchConstraint = z.infer<typeof SketchConstraintSchema>;

export const SketchSchema = z.strictObject({
  id: ObjectIdSchema,
  name: z.string().min(1).max(100),
  plane: SketchPlaneSchema,
  entities: z.array(SketchEntitySchema).max(LIMITS.maxSketchEntities),
  dimensions: z.array(SketchDimensionSchema).max(LIMITS.maxSketchEntities * 2),
  constraints: z.array(SketchConstraintSchema).max(LIMITS.maxSketchConstraints),
});
export type Sketch = z.infer<typeof SketchSchema>;

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

/**
 * 박스 모서리 처리. 필렛(둥글게: size = 반지름) 또는 모따기(size = 깎는 거리).
 * edges: 'all' 모든 12개 모서리, 'vertical' 세로(Z 방향) 4개 모서리.
 * size 는 해당 면의 가장 짧은 변의 절반보다 작아야 한다 (edgeFeature.ts, 실행기에서 검사).
 */
export const EdgeSelectionSchema = z.enum(['all', 'vertical']);
export const EdgeFeatureSchema = z.strictObject({
  type: z.enum(['fillet', 'chamfer']),
  size: z.number().min(LIMITS.minDimension).max(LIMITS.maxDimension / 2),
  edges: EdgeSelectionSchema,
});
export type EdgeFeature = z.infer<typeof EdgeFeatureSchema>;

export const CadObjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({ ...objectBase, kind: z.literal('box'), params: BoxParamsSchema, edgeFeature: EdgeFeatureSchema.optional() }),
  z.strictObject({ ...objectBase, kind: z.literal('cylinder'), params: CylinderParamsSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('sphere'), params: SphereParamsSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('cone'), params: ConeParamsSchema }),
  z.strictObject({
    ...objectBase,
    kind: z.literal('extrude'),
    params: ExtrudeParamsSchema,
    extrude: z.strictObject({ sketch: ObjectIdSchema, profile: ObjectIdSchema }),
  }),
  z.strictObject({ ...objectBase, kind: z.literal('boolean'), boolean: BooleanDefSchema }),
]);
export type CadObject = z.infer<typeof CadObjectSchema>;
export type CadObjectOf<K extends ObjectKind> = Extract<CadObject, { kind: K }>;
export type PrimitiveObject = Extract<CadObject, { kind: PrimitiveKind }>;
export type BooleanObject = CadObjectOf<'boolean'>;
export type ExtrudeObject = CadObjectOf<'extrude'>;

export const MODEL_SCHEMA_VERSION = 4;

export const ModelDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(MODEL_SCHEMA_VERSION),
  units: z.literal('mm'),
  sketches: z.array(SketchSchema).max(LIMITS.maxSketches),
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
    distance: extrudeDistance,
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: '변경할 파라미터가 하나 이상 필요합니다' });

export const SetParamsCommandSchema = z.strictObject({
  type: z.literal('set_params'),
  target: ObjectIdSchema,
  params: SetParamsParamsSchema,
});

/** 새 스케치 (기본 XY 평면, offset 0). 요소는 add_rectangle / add_circle 로 추가 */
export const CreateSketchCommandSchema = z.strictObject({
  type: z.literal('create_sketch'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  plane: SketchPlaneSchema.optional(),
});

/** 스케치에 치수형 사각형 추가 (치수 `ID.width`, `ID.height` 가 생긴다). center 는 스케치 평면 좌표 */
export const AddRectangleCommandSchema = z.strictObject({
  type: z.literal('add_rectangle'),
  sketch: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  center: Point2Schema.optional(),
  width: dimension,
  height: dimension,
});

/** 스케치에 치수형 원 추가 (치수 `ID.diameter`) */
export const AddCircleCommandSchema = z.strictObject({
  type: z.literal('add_circle'),
  sketch: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  center: Point2Schema.optional(),
  diameter: dimension,
});

/** 스케치 치수 변경 → 이 스케치를 참조하는 돌출이 다시 계산된다 */
export const SetDimensionCommandSchema = z.strictObject({
  type: z.literal('set_dimension'),
  sketch: ObjectIdSchema,
  dimension: DimensionIdSchema,
  value: dimension,
});

/** 스케치 요소의 중심 이동 (스케치 평면 좌표, mm) → 참조하는 돌출이 다시 계산된다 */
export const SetEntityCenterCommandSchema = z.strictObject({
  type: z.literal('set_entity_center'),
  sketch: ObjectIdSchema,
  entity: ObjectIdSchema,
  center: Point2Schema,
});

/** 스케치 요소 삭제 (치수도 함께). 돌출이 참조 중이면 거부 */
export const DeleteSketchEntityCommandSchema = z.strictObject({
  type: z.literal('delete_sketch_entity'),
  sketch: ObjectIdSchema,
  entity: ObjectIdSchema,
});

/** 스케치 평면 변경 (요소·치수는 평면 좌표 그대로) → 참조하는 돌출이 다시 계산된다 */
export const SetSketchPlaneCommandSchema = z.strictObject({
  type: z.literal('set_sketch_plane'),
  sketch: ObjectIdSchema,
  plane: SketchPlaneSchema,
});

/** 닫힌 다각형 추가 (꼭짓점 3~64개, 스케치 평면 좌표). 구속은 add_constraint 로 */
export const AddPolygonCommandSchema = z.strictObject({
  type: z.literal('add_polygon'),
  sketch: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  points: z.array(Point2Schema).min(3).max(LIMITS.maxPolygonPoints),
});

/** 점(다각형 꼭짓점·원/사각형 중심)을 옮기고 구속을 다시 푼다. 구속과 모순되면 거부 */
export const MovePointCommandSchema = z.strictObject({
  type: z.literal('move_point'),
  sketch: ObjectIdSchema,
  point: GeomRefSchema,
  to: Point2Schema,
});

/** 구속 추가 → 해석기가 다시 푼다. 풀 수 없으면(모순·과구속) 거부하고 원본은 그대로 */
export const AddConstraintCommandSchema = z.strictObject({
  type: z.literal('add_constraint'),
  sketch: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  constraint: ConstraintTypeSchema,
  refs: z.array(GeomRefSchema).min(1).max(2),
  value: dimension.optional(),
});

/** 길이·거리 구속 값 변경 */
export const SetConstraintCommandSchema = z.strictObject({
  type: z.literal('set_constraint'),
  sketch: ObjectIdSchema,
  constraint: ObjectIdSchema,
  value: dimension,
});

export const DeleteConstraintCommandSchema = z.strictObject({
  type: z.literal('delete_constraint'),
  sketch: ObjectIdSchema,
  constraint: ObjectIdSchema,
});

export const RenameSketchCommandSchema = z.strictObject({
  type: z.literal('rename_sketch'),
  sketch: ObjectIdSchema,
  name: NameSchema.trim(),
});

/** 스케치 삭제. 돌출이 참조 중이면 거부 (먼저 돌출 객체를 삭제) */
export const DeleteSketchCommandSchema = z.strictObject({
  type: z.literal('delete_sketch'),
  sketch: ObjectIdSchema,
});

/** 스케치 프로파일(사각형·원)을 평면 법선 방향으로 distance 만큼 돌출해 새 객체를 만든다 */
export const ExtrudeCommandSchema = z.strictObject({
  type: z.literal('extrude'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  sketch: ObjectIdSchema,
  profile: ObjectIdSchema,
  distance: extrudeDistance,
  position: Vec3Schema.optional(),
});

/** 박스 모서리를 둥글게 (radius 0 = 모서리 처리 제거). edges 생략 시 모든 모서리 */
export const FilletCommandSchema = z.strictObject({
  type: z.literal('fillet'),
  target: ObjectIdSchema,
  radius: z.number().min(0).max(LIMITS.maxDimension / 2),
  edges: EdgeSelectionSchema.optional(),
});

/** 박스 모서리를 비스듬히 깎기 (distance 0 = 모서리 처리 제거). edges 생략 시 모든 모서리 */
export const ChamferCommandSchema = z.strictObject({
  type: z.literal('chamfer'),
  target: ObjectIdSchema,
  distance: z.number().min(0).max(LIMITS.maxDimension / 2),
  edges: EdgeSelectionSchema.optional(),
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
  CreateSketchCommandSchema,
  AddRectangleCommandSchema,
  AddCircleCommandSchema,
  SetDimensionCommandSchema,
  SetEntityCenterCommandSchema,
  DeleteSketchEntityCommandSchema,
  SetSketchPlaneCommandSchema,
  AddPolygonCommandSchema,
  MovePointCommandSchema,
  AddConstraintCommandSchema,
  SetConstraintCommandSchema,
  DeleteConstraintCommandSchema,
  RenameSketchCommandSchema,
  DeleteSketchCommandSchema,
  ExtrudeCommandSchema,
  CutCommandSchema,
  UnionCommandSchema,
  IntersectCommandSchema,
  SetParamsCommandSchema,
  FilletCommandSchema,
  ChamferCommandSchema,
  TranslateCommandSchema,
  SetTransformCommandSchema,
  RenameObjectCommandSchema,
  DuplicateObjectCommandSchema,
  DeleteObjectCommandSchema,
]);
export type CadCommand = z.infer<typeof CadCommandSchema>;
export type CreateCommand = Extract<CadCommand, { type: 'create_box' | 'create_cylinder' | 'create_sphere' | 'create_cone' }>;
export type BooleanCommand = Extract<CadCommand, { type: BooleanOperation }>;

export function emptyModel(): ModelDefinition {
  return { schemaVersion: MODEL_SCHEMA_VERSION, units: 'mm', sketches: [], objects: [] };
}
