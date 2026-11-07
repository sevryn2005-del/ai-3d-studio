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
  /** 패턴 한 방향의 개수 상한, 전체 사본 수 상한 */
  maxPatternCount: 100,
  maxPatternTotal: 400,
  /** 로프트 단면 수 */
  maxLoftSections: 10,
  /** 가져온 메시 삼각형 수 (브라우저 엔진). 서버 엔진은 MAX_SERVER_MESH_TRIANGLES 까지 */
  maxMeshTriangles: 200_000,
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

/** 회전 객체의 파라미터: 회전 각도(°). 360 = 한 바퀴 */
export const RevolveParamsSchema = z.strictObject({
  angle: z.number().min(0.1, '회전 각도는 0.1° 이상이어야 합니다').max(360, '회전 각도는 360° 이하여야 합니다'),
});

/**
 * 구멍 가공 도구 (형식 v6): 원점 = 바닥면 중심, 축 = 로컬 +Z, 위(z = depth)가 가공 면.
 * 카운터보어(cboreDiameter > 0): 위에서 cboreDepth 만큼 더 큰 지름. 카운터싱크(csinkDiameter > 0): 위쪽 90° 원뿔.
 * 둘 다 0 이면 단순 구멍. 빼기의 도구로 쓰인다 (hole 명령).
 */
export const HoleParamsSchema = z
  .strictObject({
    diameter: dimension,
    depth: dimension,
    cboreDiameter: radiusOrZero,
    cboreDepth: radiusOrZero,
    csinkDiameter: radiusOrZero,
  })
  .superRefine((p, ctx) => {
    const err = (message: string) => ctx.addIssue({ code: 'custom', message });
    if (p.cboreDiameter > 0 && p.csinkDiameter > 0) err('카운터보어와 카운터싱크는 함께 쓸 수 없습니다');
    if (p.cboreDiameter > 0 && p.cboreDiameter <= p.diameter) err('카운터보어 지름은 구멍 지름보다 커야 합니다');
    if (p.cboreDiameter > 0 && !(p.cboreDepth > 0 && p.cboreDepth < p.depth)) err('카운터보어 깊이는 0보다 크고 구멍 깊이보다 작아야 합니다');
    if (p.csinkDiameter > 0 && p.csinkDiameter <= p.diameter) err('카운터싱크 지름은 구멍 지름보다 커야 합니다');
    if (p.csinkDiameter > 0 && (p.csinkDiameter - p.diameter) / 2 >= p.depth) err('카운터싱크가 구멍 깊이보다 깊습니다');
  });

/**
 * 헬릭스 스윕 (형식 v8, 나사산·스프링·블렌더 Screw): 스케치 프로파일을 회전처럼 v 축 둘레로 돌리면서
 * 한 바퀴에 pitch 만큼 v 방향으로 올린다. turns = 바퀴 수. 프로파일은 축의 한쪽(u ≥ 0)에 있어야 한다.
 */
export const HelixParamsSchema = z.strictObject({
  pitch: dimension,
  turns: z.number().min(0.1, '바퀴 수는 0.1 이상이어야 합니다').max(50, '바퀴 수는 50 이하여야 합니다'),
});

/** 도형 종류별 파라미터 스키마. 새 도형은 여기와 CadObjectSchema 에 추가한다. */
export const PARAMS_SCHEMAS = {
  box: BoxParamsSchema,
  cylinder: CylinderParamsSchema,
  sphere: SphereParamsSchema,
  cone: ConeParamsSchema,
  extrude: ExtrudeParamsSchema,
  revolve: RevolveParamsSchema,
  hole: HoleParamsSchema,
  helix: HelixParamsSchema,
} as const;

export type PrimitiveKind = keyof typeof PARAMS_SCHEMAS;
export type ObjectKind = PrimitiveKind | 'boolean' | 'pattern' | 'loft' | 'mesh' | 'fillet' | 'draft' | 'step' | 'sweep' | 'polymesh';
export const PRIMITIVE_KINDS = Object.keys(PARAMS_SCHEMAS) as PrimitiveKind[];
export type BoxParams = z.infer<typeof BoxParamsSchema>;
export type CylinderParams = z.infer<typeof CylinderParamsSchema>;
export type SphereParams = z.infer<typeof SphereParamsSchema>;
export type ConeParams = z.infer<typeof ConeParamsSchema>;

// ---- 스케치 (형식 v2) ----------------------------------------------------------
export const Point2Schema = z.tuple([coordinate, coordinate]);
export type Point2 = z.infer<typeof Point2Schema>;

/**
 * 꼭짓점 처리 (형식 v10, 스케치 필렛·모따기): 꼭짓점 k 를 반지름 size 의 접하는 호(fillet) 또는 양쪽으로 size 만큼 자른 직선(chamfer)으로.
 * 규칙: cad/curves.ts (서버 app/cad/curves.py)
 */
export const CornerSchema = z.strictObject({
  k: z.number().int().min(0).max(LIMITS.maxPolygonPoints - 1),
  type: z.enum(['fillet', 'chamfer']),
  size: z.number().min(LIMITS.minDimension / 10).max(LIMITS.maxDimension),
});
const corners = z.array(CornerSchema).max(LIMITS.maxPolygonPoints).optional();
/** 변을 호로 (형식 v13): 변 k 의 볼록 정도 bulge = tan(호 각도/4), −1~1 (±1 = 반원, 양수 = 반시계) — cad/curves.ts */
export const ArcSchema = z.strictObject({ k: z.number().int().min(0).max(LIMITS.maxPolygonPoints - 1), bulge: z.number().min(-1).max(1) });
const arcs = z.array(ArcSchema).max(LIMITS.maxPolygonPoints).optional();

export const RegionItemSchema = z.strictObject({ entity: ObjectIdSchema, op: z.enum(['add', 'subtract']) });
export const MAX_REGION_ITEMS = 100; // 스케치 요소 한도와 같음 (텍스트 윤곽 전체를 한 영역으로)
const RegionItemsSchema = z.array(RegionItemSchema).min(1).max(MAX_REGION_ITEMS);
export type RegionItem = z.infer<typeof RegionItemSchema>;

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
    corners,
    arcs,
    /** 형식 v16: 점들을 지나는 매끈한 스플라인 (cad/curves.ts splineSegments). 꼭짓점 처리·호 변과 함께 쓰지 않는다 */
    spline: z.literal(true).optional(),
  }),
  /**
   * 경로 (형식 v10): 열린 꺾은선. 스윕 중심선·리브(얇은 돌출) 선. 꼭짓점 `ID.pk`, 변 `ID.ek` (pk → p(k+1), 닫히지 않음).
   * 안쪽 꼭짓점은 corners 로 둥글게 꺾을 수 있다
   */
  z.strictObject({
    id: ObjectIdSchema,
    type: z.literal('path'),
    points: z.array(Point2Schema).min(2).max(LIMITS.maxPolygonPoints),
    corners,
    arcs,
    /** 형식 v16: 점들을 지나는 매끈한 스플라인 (cad/curves.ts splineSegments). 꼭짓점 처리·호 변과 함께 쓰지 않는다 */
    spline: z.literal(true).optional(),
  }),
  /**
   * 구성선 (형식 v7): 형상을 만들지 않는 보조 직선. 끝점 `ID.p0`·`ID.p1`, 변 `ID.e0` 으로 구속에 쓴다
   * (대칭 축·기준선·각도 기준).
   */
  z.strictObject({ id: ObjectIdSchema, type: z.literal('line'), points: z.tuple([Point2Schema, Point2Schema]) }),
  /**
   * 슬롯 (형식 v7, 긴 구멍): 중심, 방향 angle(°, u 축 기준 반시계). 치수 `ID.length` = 두 반원 중심 사이 거리,
   * `ID.width` = 폭(반원 지름). 전체 길이 = length + width
   */
  z.strictObject({ id: ObjectIdSchema, type: z.literal('slot'), center: Point2Schema, angle: z.number().min(-360).max(360) }),
  /**
   * 타원 (형식 v18): 중심, 방향 angle(°, u 축 기준 반시계). 치수 `ID.width` = 방향 축(angle) 쪽 지름, `ID.height` = 그와 수직인 지름
   */
  z.strictObject({ id: ObjectIdSchema, type: z.literal('ellipse'), center: Point2Schema, angle: z.number().min(-360).max(360) }),
  /**
   * 영역 (형식 v15): 같은 스케치의 닫힌 요소(사각형·원·다각형·슬롯)를 순서대로 합치고(add) 빼서(subtract) 만든 단면.
   * 첫 항목은 add. 구성 요소 치수를 고치면 영역도 따라 바뀐다 (잘라내기 대신 — 원본을 지우지 않는다). 돌출·회전에 쓴다
   */
  z.strictObject({ id: ObjectIdSchema, type: z.literal('region'), items: RegionItemsSchema }),
]);
export type SketchEntity = z.infer<typeof SketchEntitySchema>;

export const DimensionKindSchema = z.enum(['width', 'height', 'diameter', 'length']);
export type DimensionKind = z.infer<typeof DimensionKindSchema>;
/** 치수 ID = `요소ID.종류` (예: r1.width) */
export const DimensionIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}\.(width|height|diameter|length)$/, '치수 ID 는 "요소ID.width|height|diameter|length" 형식입니다');

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

/**
 * 각도 기준 평면 (형식 v7, 솔리드웍스 "참조 평면 — 각도"): 기준 평면 base 를 그 평면의 u 또는 v 축 둘레로 angle(°)
 * 돌린 뒤 새 법선 방향으로 offset 만큼 옮긴 평면. 예: XY 를 u(X) 축 둘레 30° = X 축을 지나는 30° 기운 평면.
 */
export const AngledPlaneSchema = z.strictObject({
  type: z.literal('angled'),
  base: SketchPlaneTypeSchema,
  axis: z.enum(['u', 'v']),
  angle: z.number().min(-360).max(360),
  offset: coordinate,
});

/**
 * 고른 면 평면 (형식 v12): 화면에서 고른 이름 없는 면(회전체·STEP 등의 평면)에 놓은 스케치. 월드 좌표의 원점·법선·u 방향.
 * 객체를 옮겨도 따라가지 않는다 (이름 있는 면은 face 평면이 따라간다)
 */
export const FramePlaneSchema = z.strictObject({ type: z.literal('frame'), origin: Vec3Schema, normal: Vec3Schema, xDir: Vec3Schema, offset: coordinate });

export const SketchPlaneSchema = z.discriminatedUnion('type', [
  StandardPlaneSchema,
  FacePlaneSchema,
  AngledPlaneSchema,
  FramePlaneSchema,
]);
export type FramePlane = z.infer<typeof FramePlaneSchema>;
export type AngledPlane = z.infer<typeof AngledPlaneSchema>;
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
  'angle', // 형식 v7: 두 변 사이 각도(°, 첫 변 → 둘째 변 반시계)
  'symmetric', // 형식 v13: 두 점이 대칭축(변)에 대해 대칭 [점, 점, 변]
  'midpoint', // 형식 v21: 점이 변의 가운데 [점, 변]. 사각형 모서리 p0..p3·변 e0..e3 도 참조할 수 있다
]);
export type ConstraintType = z.infer<typeof ConstraintTypeSchema>;
export const GeomRefSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}(\.(p|e)\d{1,2}|\.center)?$/, '참조는 "요소ID", "요소ID.center", "다각형ID.p0", "다각형ID.e0" 형식입니다');
export const SketchConstraintSchema = z.strictObject({
  id: ObjectIdSchema,
  type: ConstraintTypeSchema,
  refs: z.array(GeomRefSchema).min(1).max(3),
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

/** 외관 색 (#rrggbb 소문자) */
export const ColorSchema = z.string().regex(/^#[0-9a-f]{6}$/, '색은 #rrggbb (소문자 16진수) 형식이어야 합니다');

/**
 * 모든 객체 공통 (형식 v6 에서 선택 필드 추가 — 생략 = 기본값).
 * - suppressed: 억제. 형상 계산·표시·내보내기에서 빠진다 (불리언 도구면 그 연산만 빠짐, 기준·원본이면 상위도 빠짐)
 * - hidden: 숨기기. 화면에만 안 보인다 (계산·내보내기는 그대로)
 * - color: 외관 색
 */
const objectBase = {
  id: ObjectIdSchema,
  name: NameSchema,
  transform: TransformSchema,
  suppressed: z.boolean().optional(),
  hidden: z.boolean().optional(),
  color: ColorSchema.optional(),
};

/**
 * 모서리 선택 규칙 (형식 v9, 정밀 엔진): 감싸는 객체 좌표계(만들 때 = 월드) 기준
 * all = 모든 모서리, vertical = Z 와 나란한 직선 모서리, top / bottom = 형상의 맨 위 / 맨 아래 높이에 놓인 모서리
 */
export const EdgeRuleSchema = z.enum(['all', 'vertical', 'top', 'bottom']);
export type EdgeRule = z.infer<typeof EdgeRuleSchema>;
/**
 * 모서리 고르기 (형식 v12): 규칙(EdgeRule) 또는 화면에서 고른 모서리 위의 점들(at, 피처 좌표계).
 * 엔진은 각 점을 지나는(거리 0.001mm 이내) 모서리를 고른다 — 서버 precise.py 와 같은 규칙
 */
export const FeatureEdgesSchema = z.union([EdgeRuleSchema, z.strictObject({ at: z.array(Vec3Schema).min(1).max(200) })]);
export type FeatureEdges = z.infer<typeof FeatureEdgesSchema>;

/** 스케치 프로파일 참조 (돌출·회전·헬릭스·로프트 단면) */
export const SketchRefSchema = z.strictObject({ sketch: ObjectIdSchema, profile: ObjectIdSchema });
export type SketchRef = z.infer<typeof SketchRefSchema>;
/** base64 (메시 데이터, 최대 약 16MB) */
export const MeshBase64Schema = z.string().max(16_000_000).regex(/^[A-Za-z0-9+/]*={0,2}$/, 'base64 형식이어야 합니다');

/**
 * 쉘 (속 비우기, 형식 v6): 바깥면에서 안쪽으로 thickness 두께만 남기고 비운다. open = 제거할(열린) 면.
 * 박스(필렛 없는 것)·원통·돌출에 쓸 수 있다. 돌출의 열린 면은 start·end 만.
 */
export const ShellSchema = z.strictObject({
  thickness: z.number().min(LIMITS.minDimension).max(LIMITS.maxDimension / 2),
  open: z.array(FaceNameSchema).max(6),
});
export type Shell = z.infer<typeof ShellSchema>;

export const AxisSchema = z.enum(['x', 'y', 'z']);
export type Axis = z.infer<typeof AxisSchema>;
const patternCount = z.number().int().min(1).max(LIMITS.maxPatternCount);
const patternSpacing = z.number().min(-LIMITS.maxDimension).max(LIMITS.maxDimension);

/**
 * 패턴·대칭 (형식 v6). source 를 자식으로 가지며 결과 = 원본 ∪ 사본들. 방향·축·평면은 패턴 객체 좌표계 기준
 * (만들 때 = 월드, 원점을 지남).
 * - linear: axis 방향으로 spacing 간격 count 개 (원본 포함). axis2/count2/spacing2 로 두 번째 방향
 * - circular: axis 둘레로 count 개. angle = 360 이면 360/count 간격, 아니면 angle/(count−1) 간격
 * - mirror: plane (원점에서 법선 방향 offset) 에 대칭 복사
 */
export const PatternDefSchema = z.discriminatedUnion('type', [
  z.strictObject({
    type: z.literal('linear'),
    source: ObjectIdSchema,
    axis: AxisSchema,
    count: patternCount,
    spacing: patternSpacing,
    axis2: AxisSchema.optional(),
    count2: patternCount.optional(),
    spacing2: patternSpacing.optional(),
  }),
  z.strictObject({
    type: z.literal('circular'),
    source: ObjectIdSchema,
    axis: AxisSchema,
    count: patternCount,
    angle: z.number().min(1).max(360),
  }),
  z.strictObject({
    type: z.literal('mirror'),
    source: ObjectIdSchema,
    plane: z.enum(['XY', 'XZ', 'YZ']),
    offset: z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate),
  }),
  /** 크기 조정 (형식 v7): 패턴 좌표계 원점 기준 축별 배율 (같으면 균일). 원본 하나만 (사본 없음) */
  z.strictObject({
    type: z.literal('scale'),
    source: ObjectIdSchema,
    x: z.number().min(0.01).max(100),
    y: z.number().min(0.01).max(100),
    z: z.number().min(0.01).max(100),
  }),
]);
export type PatternDef = z.infer<typeof PatternDefSchema>;

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

/**
 * 폴리메시 (형식 v20, 3D 모델링 모드): 점(객체 로컬 mm) + 다각형 면(점 번호, 바깥에서 볼 때 반시계). 열린 메시도 된다.
 * CAD 엔진은 계산하지 않고 화면·내보내기가 그대로 쓴다. 편집은 mesh_edit 명령 (cad/polymesh.ts)
 */
export const MAX_POLY_VERTS = 50_000;
export const MAX_POLY_FACES = 50_000;
const polyCoord = z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate);
export const PolyMeshDataSchema = z.strictObject({
  verts: z.array(z.tuple([polyCoord, polyCoord, polyCoord])).max(MAX_POLY_VERTS),
  faces: z.array(z.array(z.number().int().min(0)).min(3).max(256)).max(MAX_POLY_FACES),
});
export type PolyMeshData = z.infer<typeof PolyMeshDataSchema>;

/** 메시 모디파이어 (형식 v22, 블렌더 모디파이어 스택) — cad/polymeshModifiers.ts. 위에서부터 차례로 적용 */
export const ModifierSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('subsurf'), levels: z.number().int().min(1).max(3) }),
  z.strictObject({ type: z.literal('mirror'), axis: z.enum(['x', 'y', 'z']), merge: z.boolean() }),
  z.strictObject({ type: z.literal('array'), count: z.number().int().min(2).max(50), offset: Vec3Schema }),
  z.strictObject({ type: z.literal('solidify'), thickness: z.number().min(0.01).max(LIMITS.maxDimension) }),
]);
export const MAX_MODIFIERS = 16;

export const CadObjectSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    ...objectBase,
    kind: z.literal('box'),
    params: BoxParamsSchema,
    edgeFeature: EdgeFeatureSchema.optional(),
    shell: ShellSchema.optional(),
  }),
  z.strictObject({ ...objectBase, kind: z.literal('cylinder'), params: CylinderParamsSchema, shell: ShellSchema.optional() }),
  z.strictObject({ ...objectBase, kind: z.literal('sphere'), params: SphereParamsSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('cone'), params: ConeParamsSchema }),
  z.strictObject({
    ...objectBase,
    kind: z.literal('extrude'),
    params: ExtrudeParamsSchema,
    /** thin (형식 v10, 리브·얇은 피처): 열린 선(구성선·경로)을 두께 thin 으로 띄운 단면을 돌출 */
    extrude: z.strictObject({ sketch: ObjectIdSchema, profile: ObjectIdSchema, thin: z.number().min(LIMITS.minDimension).max(LIMITS.maxDimension).optional() }),
    shell: ShellSchema.optional(),
  }),
  /**
   * 회전 (형식 v5): 스케치 프로파일을 스케치의 v 축(u = 0 인 직선) 둘레로 angle 만큼 돌린다.
   * 양의 각도는 +u 쪽 점이 −w(법선 반대) 쪽으로 돈다 (CadQuery revolve 와 같은 오른손 규칙).
   * 프로파일은 축의 한쪽(u ≥ 0)에 있어야 한다.
   */
  z.strictObject({
    ...objectBase,
    kind: z.literal('revolve'),
    params: RevolveParamsSchema,
    revolve: z.strictObject({ sketch: ObjectIdSchema, profile: ObjectIdSchema }),
  }),
  z.strictObject({ ...objectBase, kind: z.literal('boolean'), boolean: BooleanDefSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('hole'), params: HoleParamsSchema }),
  z.strictObject({ ...objectBase, kind: z.literal('pattern'), pattern: PatternDefSchema }),
  z.strictObject({
    ...objectBase,
    kind: z.literal('helix'),
    params: HelixParamsSchema,
    helix: z.strictObject({ sketch: ObjectIdSchema, profile: ObjectIdSchema }),
  }),
  /**
   * 로프트 (형식 v8): 단면(스케치 프로파일)들을 순서대로 직선(룰드) 면으로 잇는다. 단면마다 둘레를 같은 수의 점으로
   * 나눠(+u 방향에서 시작, 반시계) 대응시킨다 — 두 엔진이 같은 규칙 (cad/sections.ts ↔ app/cad/sections.py)
   */
  /**
   * 스윕 (형식 v10): 단면(profile)을 경로(path 요소, 다른 스케치 가능)를 따라 쓸어 만든 형상.
   * 단면은 바운딩 박스 중심이 경로 시작점에 오도록 경로 방향과 수직으로 세운다 (단면 v 축 = 경로 평면의 법선)
   */
  z.strictObject({
    ...objectBase,
    kind: z.literal('sweep'),
    sweep: z.strictObject({ sketch: ObjectIdSchema, profile: ObjectIdSchema, pathSketch: ObjectIdSchema, path: ObjectIdSchema }),
  }),
  z.strictObject({
    ...objectBase,
    kind: z.literal('loft'),
    loft: z.strictObject({ sections: z.array(SketchRefSchema).min(2).max(LIMITS.maxLoftSections) }),
  }),
  /**
   * 가져온 메시 (형식 v8, STL·OBJ): 삼각형 메시 그대로. positions = Float32 리틀엔디안 xyz (mm, 객체 로컬),
   * indices = Uint32 리틀엔디안 (삼각형마다 3개). base64. 닫힌(새지 않는) 메시여야 불리언·내보내기가 된다.
   */
  z.strictObject({
    ...objectBase,
    kind: z.literal('mesh'),
    mesh: z.strictObject({ positions: MeshBase64Schema, indices: MeshBase64Schema }),
  }),
  z.strictObject({
    ...objectBase,
    kind: z.literal('polymesh'),
    polymesh: PolyMeshDataSchema,
    /** 형식 v22: 모디파이어 스택, 부드러운 음영(화면 표시만) */
    modifiers: z.array(ModifierSchema).max(MAX_MODIFIERS).optional(),
    smooth: z.boolean().optional(),
  }),
  /**
   * 모서리 처리 (형식 v9, 정밀 엔진 — 서버 CadQuery·브라우저 OCCT): 원본(source, 자식) 형상의 모서리를 규칙(edges)으로 골라
   * 필렛(둥글게, size = 반지름) 또는 모따기(size = 깎는 거리). 어떤 형상(불리언·돌출·회전 결과 포함)에도 쓸 수 있다
   */
  z.strictObject({
    ...objectBase,
    kind: z.literal('fillet'),
    fillet: z.strictObject({
      source: ObjectIdSchema,
      type: z.enum(['fillet', 'chamfer']),
      size: z.number().min(LIMITS.minDimension / 2).max(LIMITS.maxDimension / 2),
      edges: FeatureEdgesSchema,
    }),
  }),
  /**
   * 구배 (형식 v9, 정밀 엔진): 원본의 세로 면(Z 와 나란한 평면·원통면)을 맨 아래 높이를 기준으로 angle(°)만큼 기울인다.
   * 양수 = 위로 갈수록 안쪽 (사출·주조 금형에서 빠지는 방향 +Z)
   */
  z.strictObject({
    ...objectBase,
    kind: z.literal('draft'),
    draft: z.strictObject({ source: ObjectIdSchema, angle: z.number().min(-30).max(30) }),
  }),
  /** 가져온 STEP (형식 v9, 정밀 엔진): STEP 파일 내용(base64) 그대로 — 정확한 곡면(B-rep) */
  z.strictObject({ ...objectBase, kind: z.literal('step'), step: z.strictObject({ data: MeshBase64Schema }) }),
]);
export type CadObject = z.infer<typeof CadObjectSchema>;
export type CadObjectOf<K extends ObjectKind> = Extract<CadObject, { kind: K }>;
export type PrimitiveObject = Extract<CadObject, { kind: PrimitiveKind }>;
export type BooleanObject = CadObjectOf<'boolean'>;
export type ExtrudeObject = CadObjectOf<'extrude'>;
export type PatternObject = CadObjectOf<'pattern'>;

/**
 * 조립 메이트 (형식 v11): 최상위 객체(부품)끼리의 위치 관계. 참조 = "객체ID.면이름" | "객체ID.axis" | (fix) "객체ID".
 * 저장된 변환이 푼 결과다 (규칙: cad/mates.ts, 서버 app/cad/mates.py 가 만족 여부를 검사)
 */
export const MateTypeSchema = z.enum(['coincident', 'distance', 'parallel', 'perpendicular', 'angle', 'concentric', 'fix']);
const MateRefNameSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]{0,63}(\.(top|bottom|\+X|-X|\+Y|-Y|start|end|\+u|-u|\+v|-v|axis))?$/, '메이트 참조는 "객체ID.면" 또는 "객체ID.axis" 입니다');
/**
 * 화면에서 고른 이름 없는 면·축 (형식 v12): 부품 로컬 좌표의 원점·방향을 그대로 저장한다 (치수가 바뀌어도 따라가지 않음).
 * 이름 있는 면이면 이름 참조("객체ID.면")로 저장해 치수를 따라간다
 */
export const MateRefCapturedSchema = z.strictObject({ object: ObjectIdSchema, kind: z.enum(['face', 'axis']), origin: Vec3Schema, dir: Vec3Schema });
export const MateRefSchema = z.union([MateRefNameSchema, MateRefCapturedSchema]);
export type MateRef = z.infer<typeof MateRefSchema>;
export const MateSchema = z.strictObject({
  id: ObjectIdSchema,
  type: MateTypeSchema,
  refs: z.array(MateRefSchema).min(1).max(2),
  value: z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate).optional(),
  flip: z.boolean().optional(),
});
export type Mate = z.infer<typeof MateSchema>;
export const MAX_MATES = 200;

/**
 * 도면 설정 (형식 v14): 도면은 모델에서 자동으로 만들어지고, 여기에는 보는 방법만 저장한다 (features/drawing/sheet.ts).
 * - views: 그릴 표준 보기 (3각법), scale: 'auto' = 들어가는 가장 큰 표준 척도
 * - section: 정면도(평면 y = offset, 앞쪽을 걷어냄) 또는 우측면도(평면 x = offset, 오른쪽을 걷어냄)를 전단면도 A-A 로
 * - centerlines: 원 중심 표시·원통 축선, notes: 표제란 위 주기(여러 줄)
 */
export const DrawingViewNameSchema = z.enum(['front', 'top', 'right', 'iso']);
export const DrawingSectionSchema = z.strictObject({
  view: z.enum(['front', 'right']),
  offset: z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate),
  /**
   * 부분 단면 (형식 v26): 보기 좌표 사각 영역 [u0, v0, u1, v1] 안만 걷어낸다 (정면 u = x · 우측면 u = y, v = z).
   * 없으면 전단면. 부분 단면은 절단선·"단면 A-A" 라벨 없이 영역 안만 해칭
   */
  rect: z.tuple([z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate), z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate), z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate), z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate)]).optional(),
});
export type DrawingSection = z.infer<typeof DrawingSectionSchema>;
/**
 * 사용자 치수 끝점 (형식 v17): at = 보기 평면 좌표(mm), rel = 보기 범위 안 상대 위치(0~1).
 * 다시 그릴 때 rel 위치(없으면 at) 가까운 꼭짓점·원에 다시 붙는다 (features/drawing/dims.ts) — 모델 크기가 바뀌어도 따라간다
 */
const coord = z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate);
export const DrawingAnchorSchema = z.strictObject({ at: z.tuple([coord, coord]), rel: z.tuple([z.number().min(-10).max(11), z.number().min(-10).max(11)]) });
export type DrawingAnchor = z.infer<typeof DrawingAnchorSchema>;
/**
 * 사용자 치수 (형식 v17): 수평·수직·평행(두 끝점 a·b, offset = 치수선까지 종이 mm, 부호 = 방향) 또는 지름(a = 원 중심, offset = 지시선 길이).
 * 등각도에는 넣지 않는다
 */
export const DrawingDimSchema = z.strictObject({
  id: ObjectIdSchema,
  view: z.enum(['front', 'top', 'right']),
  kind: z.enum(['horizontal', 'vertical', 'aligned', 'diameter']),
  a: DrawingAnchorSchema,
  b: DrawingAnchorSchema.optional(),
  offset: z.number().min(-200).max(200),
  /** 공차 (형식 v23): 위·아래 치수 허용차 (mm, 부호 포함). 같은 크기 반대 부호면 ±로 쓴다 */
  tol: z.strictObject({ upper: z.number().min(-100).max(100), lower: z.number().min(-100).max(100) }).optional(),
});
export type DrawingDim = z.infer<typeof DrawingDimSchema>;
/**
 * 상세도 (형식 v23): 보기 view 의 원 영역(center·radius, 보기 좌표 mm)을 시트 척도의 scale 배로 확대해 빈 자리에 그린다.
 * 원 영역 둘레·기호(B, C, …)를 원래 보기에 표시한다 (features/drawing/sheet.ts)
 */
export const DrawingDetailSchema = z.strictObject({
  id: ObjectIdSchema,
  view: z.enum(['front', 'top', 'right']),
  center: z.tuple([coord, coord]),
  radius: z.number().min(0.01).max(LIMITS.maxDimension),
  scale: z.number().min(1.1).max(50),
});
export type DrawingDetail = z.infer<typeof DrawingDetailSchema>;
export const MAX_DRAWING_DETAILS = 4;
/**
 * 표면 거칠기 기호 (형식 v24, ISO 1302 Ra): 보기 view 의 선(가장자리) 위 한 점에 붙는다. at·rel 은 치수 끝점과 같은 방식이고,
 * 다시 그릴 때 가장 가까운 보이는 선 위 점으로 다시 붙는다. 기호는 형상 바깥쪽에 선다 (features/drawing/sheet.ts)
 */
export const DrawingMarkSchema = z.strictObject({
  id: ObjectIdSchema,
  view: z.enum(['front', 'top', 'right']),
  at: DrawingAnchorSchema,
  ra: z.number().min(0.006).max(400),
});
export type DrawingMark = z.infer<typeof DrawingMarkSchema>;
export const MAX_DRAWING_MARKS = 50;
/**
 * 보조 투상도 (형식 v25): 부모 보기(view)에서 angle(°, 보기 x 축에서 반시계) 방향 쪽에서 본 투상 — 그 방향에 수직인 기울어진 면이
 * 실제 모양으로 보인다 (features/drawing/views.ts auxDirection). 엔진은 순서대로 aux1, aux2 로 투상한다
 */
export const DrawingAuxSchema = z.strictObject({
  id: ObjectIdSchema,
  view: z.enum(['front', 'top', 'right']),
  angle: z.number().min(-360).max(360),
});
export type DrawingAux = z.infer<typeof DrawingAuxSchema>;
export const MAX_DRAWING_AUX = 2;
export const MAX_DRAWING_DIMS = 100;
export const DrawingSettingsSchema = z.strictObject({
  paper: z.enum(['A4', 'A3']),
  scale: z.union([z.literal('auto'), z.number().min(0.0001).max(100)]),
  title: z.string().max(80).optional(),
  views: z.array(DrawingViewNameSchema).max(4),
  dimensions: z.boolean(),
  centerlines: z.boolean(),
  section: DrawingSectionSchema.optional(),
  notes: z.string().max(500).optional(),
  dims: z.array(DrawingDimSchema).max(MAX_DRAWING_DIMS).optional(),
  details: z.array(DrawingDetailSchema).max(MAX_DRAWING_DETAILS).optional(),
  marks: z.array(DrawingMarkSchema).max(MAX_DRAWING_MARKS).optional(),
  aux: z.array(DrawingAuxSchema).max(MAX_DRAWING_AUX).optional(),
});
export type DrawingSettings = z.infer<typeof DrawingSettingsSchema>;
export const DEFAULT_DRAWING: DrawingSettings = { paper: 'A4', scale: 'auto', views: ['front', 'top', 'right', 'iso'], dimensions: true, centerlines: true };

/**
 * 작업 모드 (형식 v19): 'design' = 설계(솔리드웍스식: 평면 → 2D 스케치 → 피처), 'modeling' = 3D 모델링(블렌더식 메시 편집).
 * 없으면 예전 파일 그대로의 통합 화면. 만들 때 정하고 명령으로 바꾸지 않는다
 */
export const WorkspaceSchema = z.enum(['design', 'modeling']);
export type Workspace = z.infer<typeof WorkspaceSchema>;

export const MODEL_SCHEMA_VERSION = 26;

export const ModelDefinitionSchema = z.strictObject({
  schemaVersion: z.literal(MODEL_SCHEMA_VERSION),
  units: z.literal('mm'),
  sketches: z.array(SketchSchema).max(LIMITS.maxSketches),
  objects: z.array(CadObjectSchema).max(LIMITS.maxObjects, `객체는 최대 ${LIMITS.maxObjects}개까지 가능합니다`),
  mates: z.array(MateSchema).max(MAX_MATES).optional(),
  drawing: DrawingSettingsSchema.optional(),
  workspace: WorkspaceSchema.optional(),
});
export type ModelDefinition = z.infer<typeof ModelDefinitionSchema>;

/** 메이트 추가 (형식 v11): 추가하면 부품 위치를 다시 푼다 */
export const AddMateCommandSchema = z.strictObject({
  type: z.literal('add_mate'),
  id: ObjectIdSchema.optional(),
  mate: MateTypeSchema,
  refs: z.array(MateRefSchema).min(1).max(2),
  value: z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate).optional(),
  flip: z.boolean().optional(),
});
/** 메이트 값·방향 바꾸기 */
export const SetMateCommandSchema = z.strictObject({
  type: z.literal('set_mate'),
  mate: ObjectIdSchema,
  value: z.number().min(-LIMITS.maxCoordinate).max(LIMITS.maxCoordinate).optional(),
  flip: z.boolean().optional(),
});
export const DeleteMateCommandSchema = z.strictObject({ type: z.literal('delete_mate'), mate: ObjectIdSchema });

/** 도면 설정 바꾸기 (형식 v14): 설정 전체를 바꾼다. 형상은 바뀌지 않는다 */
export const SetDrawingCommandSchema = z.strictObject({ type: z.literal('set_drawing'), drawing: DrawingSettingsSchema });

/**
 * 부품 삽입 (조립품): 다른 프로젝트(.ai3d)의 설계 원본을 복사해 넣는다. ID 는 겹치지 않게 다시 붙이고,
 * 최상위 객체가 여럿이면 하나의 합치기로 묶어 부품 하나가 되게 한다
 */
export const InsertPartCommandSchema = z.strictObject({
  type: z.literal('insert_part'),
  name: NameSchema,
  part: z.strictObject({
    sketches: z.array(SketchSchema).max(LIMITS.maxSketches),
    objects: z.array(CadObjectSchema).min(1).max(LIMITS.maxObjects),
  }),
  position: Vec3Schema.optional(),
});

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
    angle: RevolveParamsSchema.shape.angle,
    diameter: dimension,
    cboreDiameter: radiusOrZero,
    cboreDepth: radiusOrZero,
    csinkDiameter: radiusOrZero,
    pitch: dimension,
    turns: HelixParamsSchema.shape.turns,
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

/** 구성선 추가 (형상을 만들지 않는 보조선, 구속 기준) */
/** 경로(열린 꺾은선) 추가: 스윕 중심선·리브 선 */
export const AddPathCommandSchema = z.strictObject({
  type: z.literal('add_path'),
  sketch: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  points: z.array(Point2Schema).min(2).max(LIMITS.maxPolygonPoints),
});

/** 스케치 필렛·모따기: 다각형·경로의 꼭짓점(vertices 생략 = 처리할 수 있는 모든 꼭짓점). size 0 = 처리 제거 */
export const SetCornerCommandSchema = z.strictObject({
  type: z.literal('set_corner'),
  sketch: ObjectIdSchema,
  entity: ObjectIdSchema,
  vertices: z.array(z.number().int().min(0).max(LIMITS.maxPolygonPoints - 1)).max(LIMITS.maxPolygonPoints).optional(),
  corner: z.enum(['fillet', 'chamfer']),
  size: z.number().min(0).max(LIMITS.maxDimension),
});

/** 리브(얇은 돌출) 두께 바꾸기 */
export const SetThinCommandSchema = z.strictObject({
  type: z.literal('set_thin'),
  target: ObjectIdSchema,
  thin: z.number().min(LIMITS.minDimension).max(LIMITS.maxDimension),
});

/** 변을 호로 (형식 v13): 다각형·경로의 변 edge 를 볼록 정도 bulge 의 원호로 (0 = 직선) */
export const SetArcCommandSchema = z.strictObject({
  type: z.literal('set_arc'),
  sketch: ObjectIdSchema,
  entity: ObjectIdSchema,
  edge: z.number().int().min(0).max(LIMITS.maxPolygonPoints - 1),
  bulge: z.number().min(-1).max(1),
});

/** 영역 단면 추가 (형식 v15): 닫힌 요소를 순서대로 합치고 빼기. 첫 항목은 add */
export const AddRegionCommandSchema = z.strictObject({ type: z.literal('add_region'), sketch: ObjectIdSchema, id: ObjectIdSchema.optional(), items: RegionItemsSchema });
/** 영역 구성 바꾸기 */
export const SetRegionCommandSchema = z.strictObject({ type: z.literal('set_region'), sketch: ObjectIdSchema, entity: ObjectIdSchema, items: RegionItemsSchema });

/** 스플라인 켜기·끄기 (형식 v16): 다각형·경로의 점들을 지나는 매끈한 곡선으로. 켜면 꼭짓점 처리·호 변은 지운다 */
export const SetSplineCommandSchema = z.strictObject({ type: z.literal('set_spline'), sketch: ObjectIdSchema, entity: ObjectIdSchema, spline: z.boolean() });

/** 사각형을 같은 모양의 다각형으로 바꾼다 (꼭짓점 이동·필렛·호를 쓰려고). 중심 구속은 지워진다 */
export const ConvertToPolygonCommandSchema = z.strictObject({ type: z.literal('convert_to_polygon'), sketch: ObjectIdSchema, entity: ObjectIdSchema });

/** 스윕: 단면을 경로를 따라 쓸기 */
export const SweepCommandSchema = z.strictObject({
  type: z.literal('sweep'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  sketch: ObjectIdSchema,
  profile: ObjectIdSchema,
  pathSketch: ObjectIdSchema,
  path: ObjectIdSchema,
});

export const AddLineCommandSchema = z.strictObject({
  type: z.literal('add_line'),
  sketch: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  points: z.tuple([Point2Schema, Point2Schema]),
});

/** 슬롯(긴 구멍) 추가: length = 반원 중심 사이 거리, width = 폭, angle = 방향(°) */
export const AddSlotCommandSchema = z.strictObject({
  type: z.literal('add_slot'),
  sketch: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  center: Point2Schema.optional(),
  length: dimension,
  width: dimension,
  angle: z.number().min(-360).max(360).optional(),
});

/** 슬롯 방향(°) 바꾸기 */
export const SetEntityAngleCommandSchema = z.strictObject({
  type: z.literal('set_entity_angle'),
  sketch: ObjectIdSchema,
  entity: ObjectIdSchema,
  angle: z.number().min(-360).max(360),
});

/** 타원 추가 (형식 v18): width = 방향 축 지름, height = 수직 지름 */
export const AddEllipseCommandSchema = z.strictObject({
  type: z.literal('add_ellipse'),
  sketch: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  center: Point2Schema.optional(),
  width: dimension,
  height: dimension,
  angle: z.number().min(-360).max(360).optional(),
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
  refs: z.array(GeomRefSchema).min(1).max(3),
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

/** 스케치 프로파일을 스케치 v 축(u = 0) 둘레로 angle(기본 360°) 만큼 회전해 새 객체를 만든다 */
export const RevolveCommandSchema = z.strictObject({
  type: z.literal('revolve'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  sketch: ObjectIdSchema,
  profile: ObjectIdSchema,
  angle: RevolveParamsSchema.shape.angle.optional(),
  position: Vec3Schema.optional(),
});

/** 헬릭스 스윕 (나사산·스프링): 회전처럼 v 축 둘레로 turns 바퀴, 한 바퀴에 pitch 만큼 올라감 */
export const HelixCommandSchema = z.strictObject({
  type: z.literal('helix'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  sketch: ObjectIdSchema,
  profile: ObjectIdSchema,
  pitch: dimension,
  turns: HelixParamsSchema.shape.turns,
});

/** 로프트: 단면 2~10개를 순서대로 잇는다 (각각 스케치·프로파일) */
export const LoftCommandSchema = z.strictObject({
  type: z.literal('loft'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  sections: z.array(SketchRefSchema).min(2).max(LIMITS.maxLoftSections),
});

/** 메시 가져오기 (STL·OBJ 를 읽은 결과). 원점 규칙에 맞게 바닥면 중심으로 옮겨 저장한다 */
export const ImportMeshCommandSchema = z.strictObject({
  type: z.literal('import_mesh'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  positions: MeshBase64Schema,
  indices: MeshBase64Schema,
  position: Vec3Schema.optional(),
});

/** 메시 추가 (형식 v20, 블렌더 Shift+A): 기본 도형 폴리메시. 크기는 mm, 원점 = 도형 가운데 */
export const MeshPrimitiveSchema = z.enum(['cube', 'plane', 'uv_sphere', 'cylinder', 'cone', 'torus', 'grid']);
export const AddMeshCommandSchema = z.strictObject({
  type: z.literal('add_mesh'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  primitive: MeshPrimitiveSchema,
  params: z
    .strictObject({
      size: dimension.optional(),
      radius: dimension.optional(),
      depth: dimension.optional(),
      minorRadius: dimension.optional(),
      segments: z.number().int().min(3).max(256).optional(),
      rings: z.number().int().min(3).max(128).optional(),
      subdivisions: z.number().int().min(1).max(100).optional(),
    })
    .optional(),
  position: Vec3Schema.optional(),
});

const vertIds = z.array(z.number().int().min(0)).max(MAX_POLY_VERTS);
const faceIds = z.array(z.number().int().min(0)).max(MAX_POLY_FACES);
/** 메시 편집 한 번 (블렌더 편집 모드 연산) — cad/polymesh.ts */
export const MeshEditSchema = z.discriminatedUnion('op', [
  /** G/R/S: 고른 점에 4×4 행렬 (열 우선, 객체 로컬) */
  z.strictObject({ op: z.literal('transform'), verts: vertIds.min(1), matrix: z.array(z.number()).length(16) }),
  /** E: 면 돌출 (영역) */
  z.strictObject({ op: z.literal('extrude'), faces: faceIds.min(1), offset: Vec3Schema }),
  /** I: 인셋 (면마다) */
  z.strictObject({ op: z.literal('inset'), faces: faceIds.min(1), thickness: z.number().min(0.0001).max(LIMITS.maxDimension) }),
  /** X: 삭제 — 점 / 선(고른 점 둘을 잇는 선) / 면(점이 모두 고른 면) */
  z.strictObject({ op: z.literal('delete'), verts: vertIds.min(1), mode: z.enum(['verts', 'edges', 'faces']) }),
  /** Ctrl+R: 선 (a, b) 를 지나는 사각형 띠를 factor 지점에서 자른다 */
  z.strictObject({ op: z.literal('loop_cut'), edge: z.tuple([z.number().int().min(0), z.number().int().min(0)]), factor: z.number().min(0.01).max(0.99) }),
  /** 세분 (면마다 가운데 점) */
  z.strictObject({ op: z.literal('subdivide'), faces: faceIds.min(1) }),
  /** M: 가운데로 병합 */
  z.strictObject({ op: z.literal('merge'), verts: vertIds.min(2) }),
  /** F: 고른 점들로 면 */
  z.strictObject({ op: z.literal('fill'), verts: vertIds.min(3).max(256) }),
  /** K 나이프·이등분: 평면(point, normal, 객체 로컬)으로 면을 자른다. faces 가 비면 모든 면 */
  z.strictObject({ op: z.literal('bisect'), faces: z.array(z.number().int().min(0)).max(MAX_POLY_FACES), point: Vec3Schema, normal: Vec3Schema }),
  /** Ctrl+B 베벨: 고른 점들 사이 선(양 끝이 모두 고른 선)을 width 만큼 모따기 */
  z.strictObject({ op: z.literal('bevel'), verts: vertIds.min(2), width: z.number().min(0.0001).max(LIMITS.maxDimension), segments: z.number().int().min(1).max(12).optional() }),
  /** 점 위치 바꾸기 (스컬프트 한 획): 고른 점들을 새 좌표로 (객체 로컬, mm) */
  z.strictObject({
    op: z.literal('set_verts'),
    verts: vertIds.min(1),
    positions: z.array(Vec3Schema).min(1).max(MAX_POLY_VERTS),
  }),
  /** 복셀 리메시 (스컬프트 Ctrl+R): 모양을 voxel(mm) 간격의 고른 사각형 그물로 다시 짠다. smooth = 다듬기 횟수 (생략 2) */
  z.strictObject({ op: z.literal('remesh'), voxel: z.number().min(0.01).max(LIMITS.maxDimension), smooth: z.number().int().min(0).max(10).optional() }),
  /** 메시 통째로 바꾸기 (다이나믹 토폴로지 스컬프트 한 획 — 점과 면이 함께 바뀜) */
  z.strictObject({ op: z.literal('replace'), mesh: PolyMeshDataSchema }),
]);
export type MeshEdit = z.infer<typeof MeshEditSchema>;
export const MeshEditCommandSchema = z.strictObject({ type: z.literal('mesh_edit'), target: ObjectIdSchema, edit: MeshEditSchema });
/** 모디파이어 스택 바꾸기 (추가·삭제·순서·값 모두 — 스택 전체를 보낸다) */
export const SetModifiersCommandSchema = z.strictObject({
  type: z.literal('set_modifiers'),
  target: ObjectIdSchema,
  modifiers: z.array(ModifierSchema).max(MAX_MODIFIERS),
});
/** 모디파이어 적용: 맨 위 하나(또는 all = 전부)를 메시에 굳힌다 */
export const ApplyModifierCommandSchema = z.strictObject({ type: z.literal('apply_modifier'), target: ObjectIdSchema, all: z.boolean().optional() });
/**
 * 메시로 변환 (3D 모델링 모드): 최상위 객체(설계 부품·불리언 결과)를 엔진이 계산한 모양 그대로 편집 메시로 바꾼다.
 * 같은 ID·이름·위치, 하위 객체는 지운다. polymesh 는 화면이 엔진 결과에서 만든다 (cad/meshConvert.ts)
 */
export const ConvertToMeshCommandSchema = z.strictObject({ type: z.literal('convert_to_mesh'), target: ObjectIdSchema, polymesh: PolyMeshDataSchema });
/** 부드러운 / 각진 음영 (블렌더 Shade Smooth / Flat) */
export const SetShadingCommandSchema = z.strictObject({ type: z.literal('set_shading'), target: ObjectIdSchema, smooth: z.boolean() });

/** 모서리 처리 만들기 (정밀 엔진): target(최상위)을 원본으로 감싼다 */
export const EdgeFeatureCommandSchema = z.strictObject({
  type: z.literal('edge_feature'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  target: ObjectIdSchema,
  feature: z.enum(['fillet', 'chamfer']),
  size: z.number().min(LIMITS.minDimension / 2).max(LIMITS.maxDimension / 2),
  edges: FeatureEdgesSchema,
});

/** 모서리 처리 값 바꾸기 */
export const SetEdgeFeatureCommandSchema = z.strictObject({
  type: z.literal('set_edge_feature'),
  target: ObjectIdSchema,
  feature: z.enum(['fillet', 'chamfer']).optional(),
  size: z.number().min(LIMITS.minDimension / 2).max(LIMITS.maxDimension / 2).optional(),
  edges: FeatureEdgesSchema.optional(),
});

/** 구배 만들기 / 바꾸기 (정밀 엔진) */
export const DraftCommandSchema = z.strictObject({
  type: z.literal('draft'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  target: ObjectIdSchema,
  angle: z.number().min(-30).max(30),
});
export const SetDraftCommandSchema = z.strictObject({
  type: z.literal('set_draft'),
  target: ObjectIdSchema,
  angle: z.number().min(-30).max(30),
});

/** STEP 가져오기 (파일 내용 base64). 원점 규칙으로 옮기는 것은 position 으로 */
export const ImportStepCommandSchema = z.strictObject({
  type: z.literal('import_step'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  data: MeshBase64Schema,
  position: Vec3Schema.optional(),
});

/** 스케치 요소 오프셋: 같은 모양을 distance 만큼 바깥(+)·안쪽(−)으로 띄운 새 요소 (다각형은 모서리 연장) */
export const OffsetEntityCommandSchema = z.strictObject({
  type: z.literal('offset_entity'),
  sketch: ObjectIdSchema,
  entity: ObjectIdSchema,
  id: ObjectIdSchema.optional(),
  distance: z.number().min(-LIMITS.maxDimension).max(LIMITS.maxDimension),
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
  /** 얇은 돌출·리브 (형식 v10): profile 이 열린 선(구성선·경로)일 때 두께 */
  thin: z.number().min(LIMITS.minDimension).max(LIMITS.maxDimension).optional(),
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

/** 억제 켜기/끄기 (피처를 지우지 않고 잠시 빼 보기) */
export const SetSuppressedCommandSchema = z.strictObject({
  type: z.literal('set_suppressed'),
  target: ObjectIdSchema,
  suppressed: z.boolean(),
});

/** 외관: 색 ('default' = 기본색), 숨기기 */
export const SetAppearanceCommandSchema = z
  .strictObject({
    type: z.literal('set_appearance'),
    target: ObjectIdSchema,
    color: z.union([ColorSchema, z.literal('default')]).optional(),
    hidden: z.boolean().optional(),
  })
  .refine((c) => c.color !== undefined || c.hidden !== undefined, { message: 'color 또는 hidden 이 필요합니다' });

/** 쉘 (속 비우기). thickness 0 = 쉘 제거. open 생략 = 열린 면 없음 (속이 빈 닫힌 형상) */
export const ShellCommandSchema = z.strictObject({
  type: z.literal('shell'),
  target: ObjectIdSchema,
  thickness: z.number().min(0).max(LIMITS.maxDimension / 2),
  open: z.array(FaceNameSchema).max(6).optional(),
});

/** 패턴·대칭 만들기: source(최상위 객체)를 자식으로 갖는 패턴 객체 */
export const PatternCommandSchema = z.strictObject({
  type: z.literal('pattern'),
  id: ObjectIdSchema.optional(),
  name: NameSchema.optional(),
  pattern: PatternDefSchema,
});

/** 패턴 값 바꾸기 (원본은 바꿀 수 없음) */
export const SetPatternCommandSchema = z.strictObject({
  type: z.literal('set_pattern'),
  target: ObjectIdSchema,
  pattern: PatternDefSchema,
});

/**
 * 구멍 가공: target 의 이름 있는 면(face) 위 점 at = [u, v] (면 좌표, mm) 에서 면 안쪽으로 구멍을 뚫는다.
 * = 구멍 도구(hole 객체) + 빼기. target 이 이미 빼기 결과면 그 빼기에 도구로 더한다 (중첩이 깊어지지 않음).
 */
export const HoleCommandSchema = z.strictObject({
  type: z.literal('hole'),
  id: ObjectIdSchema.optional(),
  target: ObjectIdSchema,
  face: FaceNameSchema,
  at: Point2Schema,
  diameter: dimension,
  depth: dimension,
  cboreDiameter: radiusOrZero.optional(),
  cboreDepth: radiusOrZero.optional(),
  csinkDiameter: radiusOrZero.optional(),
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
  AddLineCommandSchema,
  AddPathCommandSchema,
  SetCornerCommandSchema,
  SetArcCommandSchema,
  ConvertToPolygonCommandSchema,
  AddRegionCommandSchema,
  SetRegionCommandSchema,
  SetSplineCommandSchema,
  AddSlotCommandSchema,
  AddEllipseCommandSchema,
  SetEntityAngleCommandSchema,
  OffsetEntityCommandSchema,
  MovePointCommandSchema,
  AddConstraintCommandSchema,
  SetConstraintCommandSchema,
  DeleteConstraintCommandSchema,
  RenameSketchCommandSchema,
  DeleteSketchCommandSchema,
  ExtrudeCommandSchema,
  RevolveCommandSchema,
  HelixCommandSchema,
  LoftCommandSchema,
  SweepCommandSchema,
  SetThinCommandSchema,
  AddMateCommandSchema,
  SetMateCommandSchema,
  DeleteMateCommandSchema,
  SetDrawingCommandSchema,
  AddMeshCommandSchema,
  MeshEditCommandSchema,
  SetModifiersCommandSchema,
  ApplyModifierCommandSchema,
  SetShadingCommandSchema,
  ConvertToMeshCommandSchema,
  InsertPartCommandSchema,
  ImportMeshCommandSchema,
  EdgeFeatureCommandSchema,
  SetEdgeFeatureCommandSchema,
  DraftCommandSchema,
  SetDraftCommandSchema,
  ImportStepCommandSchema,
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
  SetSuppressedCommandSchema,
  SetAppearanceCommandSchema,
  ShellCommandSchema,
  PatternCommandSchema,
  SetPatternCommandSchema,
  HoleCommandSchema,
]);
export type CadCommand = z.infer<typeof CadCommandSchema>;
export type CreateCommand = Extract<CadCommand, { type: 'create_box' | 'create_cylinder' | 'create_sphere' | 'create_cone' }>;
export type BooleanCommand = Extract<CadCommand, { type: BooleanOperation }>;

export function emptyModel(): ModelDefinition {
  return { schemaVersion: MODEL_SCHEMA_VERSION, units: 'mm', sketches: [], objects: [] };
}
