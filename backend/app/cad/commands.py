"""CAD 명령과 설계 원본(ModelDefinition)의 Pydantic 모델.

계약의 원본은 frontend/src/cad/commandTypes.ts (Zod) 이며,
shared/schemas/*.schema.json 으로 내보낸 결과와 이 모듈이 일치하는지
tests/test_contract.py 가 검사한다. 한쪽만 바꾸면 테스트가 실패한다.

- 단위: 길이 mm, 각도 degree. Z-up.
- 모든 기본 도형의 원점은 바운딩 박스 바닥면 중심.
- 정의되지 않은 필드는 거부한다 (extra="forbid").
- 숫자는 strict: "10" 같은 문자열, true/false, NaN/Infinity 거부.
- 불리언 객체는 base/tools 로 자식을 참조하며, 자식의 transform 은 부모 좌표계 기준 (world = parent ∘ child).
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, StringConstraints, TypeAdapter, model_validator


class Limits:
    MIN_DIMENSION = 0.1  # mm
    MAX_DIMENSION = 1000.0  # mm
    MAX_COORDINATE = 10_000.0  # mm
    MAX_ROTATION = 360.0  # deg
    MAX_OBJECTS = 1000
    MAX_BOOLEAN_TOOLS = 50
    MAX_BOOLEAN_DEPTH = 8
    MAX_SKETCHES = 200
    MAX_SKETCH_ENTITIES = 100
    MAX_POLYGON_POINTS = 64
    MAX_SKETCH_CONSTRAINTS = 300
    MAX_PATTERN_COUNT = 100
    MAX_PATTERN_TOTAL = 400


def _num(ge: float, le: float) -> object:
    return Field(strict=True, allow_inf_nan=False, ge=ge, le=le)


Dimension = Annotated[float, _num(Limits.MIN_DIMENSION, Limits.MAX_DIMENSION)]
Radius = Annotated[float, _num(Limits.MIN_DIMENSION / 2, Limits.MAX_DIMENSION / 2)]
RadiusOrZero = Annotated[float, _num(0, Limits.MAX_DIMENSION / 2)]
Coordinate = Annotated[float, _num(-Limits.MAX_COORDINATE, Limits.MAX_COORDINATE)]
Angle = Annotated[float, _num(-Limits.MAX_ROTATION, Limits.MAX_ROTATION)]
# 돌출 거리: 양수 = 평면 법선 방향, 음수 = 반대 방향 (면 위 스케치에서 안쪽으로 파내기). 크기는 치수 범위
ExtrudeDistance = Union[
    Annotated[float, _num(Limits.MIN_DIMENSION, Limits.MAX_DIMENSION)],
    Annotated[float, _num(-Limits.MAX_DIMENSION, -Limits.MIN_DIMENSION)],
]

Vec3 = tuple[Coordinate, Coordinate, Coordinate]
Rotation = tuple[Angle, Angle, Angle]

ObjectId = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-z][a-z0-9_]{0,63}$")]
# 1–100자, 공백 외 글자 1개 이상 (JSON Schema pattern "\\S" 와 동일)
Name = Annotated[str, StringConstraints(strict=True, min_length=1, max_length=100, pattern=r"\S")]
TrimmedName = Annotated[
    str,
    StringConstraints(strict=True, strip_whitespace=True, min_length=1, max_length=100, pattern=r"\S"),
]


class Strict(BaseModel):
    """모든 CAD 모델의 기반: 미정의 필드 거부, 불변, 명시적 null 거부.

    Zod 의 optional 은 "생략"만 허용하고 null 은 거부하므로 같은 규칙을 적용한다.
    """

    model_config = ConfigDict(extra="forbid", frozen=True)

    @model_validator(mode="before")
    @classmethod
    def _reject_null(cls, data: object) -> object:
        if isinstance(data, dict):
            nulls = [k for k, v in data.items() if v is None]
            if nulls:
                raise ValueError(f"null 값은 허용되지 않습니다 (필드를 생략하세요): {', '.join(nulls)}")
        return data


# ---- 설계 원본 ---------------------------------------------------------------


class BoxParams(Strict):
    width: Dimension
    depth: Dimension
    height: Dimension


class CylinderParams(Strict):
    radius: Radius
    height: Dimension


class SphereParams(Strict):
    radius: Radius


class ConeParams(Strict):
    radiusBottom: RadiusOrZero
    radiusTop: RadiusOrZero
    height: Dimension

    @model_validator(mode="after")
    def _one_radius_positive(self) -> ConeParams:
        if max(self.radiusBottom, self.radiusTop) < Limits.MIN_DIMENSION / 2:
            raise ValueError("원뿔의 위·아래 반지름 중 하나는 0보다 커야 합니다")
        return self


class ExtrudeParams(Strict):
    distance: ExtrudeDistance


RevolveAngle = Annotated[float, _num(0.1, 360)]


class RevolveParams(Strict):
    angle: RevolveAngle


class HoleParams(Strict):
    """구멍 도구 (형식 v6): 원점 = 바닥면 중심, 축 = +Z, 위(z = depth)가 가공 면. 카운터보어/카운터싱크 0 = 없음."""

    diameter: Dimension
    depth: Dimension
    cboreDiameter: RadiusOrZero
    cboreDepth: RadiusOrZero
    csinkDiameter: RadiusOrZero

    @model_validator(mode="after")
    def _rules(self) -> HoleParams:
        # frontend commandTypes.ts HoleParamsSchema 와 같은 규칙·메시지
        if self.cboreDiameter > 0 and self.csinkDiameter > 0:
            raise ValueError("카운터보어와 카운터싱크는 함께 쓸 수 없습니다")
        if self.cboreDiameter > 0 and self.cboreDiameter <= self.diameter:
            raise ValueError("카운터보어 지름은 구멍 지름보다 커야 합니다")
        if self.cboreDiameter > 0 and not (0 < self.cboreDepth < self.depth):
            raise ValueError("카운터보어 깊이는 0보다 크고 구멍 깊이보다 작아야 합니다")
        if self.csinkDiameter > 0 and self.csinkDiameter <= self.diameter:
            raise ValueError("카운터싱크 지름은 구멍 지름보다 커야 합니다")
        if self.csinkDiameter > 0 and (self.csinkDiameter - self.diameter) / 2 >= self.depth:
            raise ValueError("카운터싱크가 구멍 깊이보다 깊습니다")
        return self


PARAMS_MODELS: dict[str, type[Strict]] = {
    "box": BoxParams,
    "cylinder": CylinderParams,
    "sphere": SphereParams,
    "cone": ConeParams,
    "extrude": ExtrudeParams,
    "revolve": RevolveParams,
    "hole": HoleParams,
}


# ---- 스케치 (형식 v2) ----------------------------------------------------------------

Point2 = tuple[Coordinate, Coordinate]
DimensionKind = Literal["width", "height", "diameter"]
DimensionId = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-z][a-z0-9_]{0,63}\.(width|height|diameter)$")]


class RectangleEntity(Strict):
    id: ObjectId
    type: Literal["rectangle"]
    center: Point2


class CircleEntity(Strict):
    id: ObjectId
    type: Literal["circle"]
    center: Point2


class PolygonEntity(Strict):
    """닫힌 다각형 (형식 v4). 꼭짓점 = 구속 해석기가 푼 좌표. 꼭짓점 k = ID.pk, 변 k = ID.ek."""

    id: ObjectId
    type: Literal["polygon"]
    points: Annotated[list[Point2], Field(min_length=3, max_length=Limits.MAX_POLYGON_POINTS)]


SketchEntity = Annotated[Union[RectangleEntity, CircleEntity, PolygonEntity], Field(discriminator="type")]

ConstraintType = Literal[
    "fix", "coincident", "concentric", "horizontal", "vertical", "parallel", "perpendicular", "equal", "length", "distance", "tangent"
]
GeomRef = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-z][a-z0-9_]{0,63}(\.(p|e)\d{1,2}|\.center)?$")]


class SketchConstraint(Strict):
    """기하 구속 (frontend/src/cad/solver.ts). 값은 length·distance 만."""

    id: ObjectId
    type: ConstraintType
    refs: Annotated[list[GeomRef], Field(min_length=1, max_length=2)]
    value: Annotated[Dimension | None, Field(exclude_if=lambda v: v is None)] = None


class SketchDimension(Strict):
    id: DimensionId
    entity: ObjectId
    kind: DimensionKind
    value: Dimension


class StandardPlane(Strict):
    """CadQuery 이름 평면과 같은 규약. offset = 평면 법선 방향 거리 (mm).
    XY: u=X, v=Y, 법선 +Z · XZ: u=X, v=Z, 법선 −Y · YZ: u=Y, v=Z, 법선 +X"""

    type: Literal["XY", "XZ", "YZ"]
    offset: Coordinate


FaceName = Literal["top", "bottom", "+X", "-X", "+Y", "-Y", "start", "end", "+u", "-u", "+v", "-v"]


class FacePlane(Strict):
    """객체의 이름 있는 면에 붙는 평면 (docs/design-face-sketch.md). offset = 면의 바깥 법선 방향 거리."""

    type: Literal["face"]
    object: ObjectId
    face: FaceName
    offset: Coordinate


SketchPlane = Annotated[Union[StandardPlane, FacePlane], Field(discriminator="type")]


class Sketch(Strict):
    id: ObjectId
    name: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=100)]
    plane: SketchPlane
    entities: Annotated[list[SketchEntity], Field(max_length=Limits.MAX_SKETCH_ENTITIES)]
    dimensions: Annotated[list[SketchDimension], Field(max_length=Limits.MAX_SKETCH_ENTITIES * 2)]
    constraints: Annotated[list[SketchConstraint], Field(max_length=Limits.MAX_SKETCH_CONSTRAINTS)]


REQUIRED_DIMENSIONS = {"rectangle": ("width", "height"), "circle": ("diameter",), "polygon": ()}


def revolve_profile_error(p: dict) -> str | None:
    """회전 프로파일이 축(u = 0)의 한쪽(u ≥ 0)에 있는지 (frontend sketch.ts revolveProfileError 와 같음)."""
    if p["type"] == "polygon":
        min_u = min(q[0] for q in p["points"])
    elif p["type"] == "circle":
        min_u = p["center"][0] - p["diameter"] / 2
    else:
        min_u = p["center"][0] - p["width"] / 2
    if min_u < -1e-9:
        return f"회전 프로파일은 회전축(스케치 v 축, u = 0)의 한쪽(u ≥ 0)에 있어야 합니다 (지금 u 최소 {round(min_u, 3)})"
    return None


def resolve_profile(sketch: Sketch, entity_id: str) -> dict | None:
    """돌출 단면 (프론트엔드 cad/sketch.ts 의 resolveProfile 과 같은 규칙)."""
    e = next((x for x in sketch.entities if x.id == entity_id), None)
    if e is None:
        return None
    dims = {d.kind: d.value for d in sketch.dimensions if d.entity == e.id}
    z = sketch.plane.offset
    if e.type == "polygon":
        xs = [p[0] for p in e.points]
        ys = [p[1] for p in e.points]
        return {"type": "polygon", "points": list(e.points), "center": ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2),
                "width": max(xs) - min(xs), "height": max(ys) - min(ys), "z": z, "plane": sketch.plane}
    if e.type == "rectangle":
        if "width" in dims and "height" in dims:
            return {"type": "rectangle", "center": e.center, "width": dims["width"], "height": dims["height"], "z": z,
                    "plane": sketch.plane}
        return None
    if "diameter" in dims:
        return {"type": "circle", "center": e.center, "diameter": dims["diameter"], "z": z, "plane": sketch.plane}
    return None


class Transform(Strict):
    position: Vec3
    rotation: Rotation


Color = Annotated[str, StringConstraints(strict=True, pattern=r"^#[0-9a-f]{6}$")]
StrictBool = Annotated[bool, Field(strict=True)]


def _opt(default=None):
    """선택 필드: 없으면 직렬화에서 뺀다 (Zod optional 과 같은 의미)"""
    return Field(default=default, exclude_if=lambda v: v is None)


class _ObjectBase(Strict):
    id: ObjectId
    name: Name
    transform: Transform
    # 형식 v6: 억제(계산·내보내기 제외), 숨김(화면만), 외관 색
    suppressed: StrictBool | None = _opt()
    hidden: StrictBool | None = _opt()
    color: Color | None = _opt()

    @property
    def child_ids(self) -> list[str]:
        return []


EdgeSelection = Literal["all", "vertical"]


class EdgeFeature(Strict):
    """박스 모서리 처리: fillet(size = 반지름) / chamfer(size = 깎는 거리), edges: all | vertical"""

    type: Literal["fillet", "chamfer"]
    size: Annotated[float, _num(Limits.MIN_DIMENSION, Limits.MAX_DIMENSION / 2)]
    edges: EdgeSelection


def max_edge_size(p: BoxParams, edges: str) -> float:
    dims = [p.width, p.depth, p.height] if edges == "all" else [p.width, p.depth]
    return min(dims) / 2


FaceName = Literal["top", "bottom", "+X", "-X", "+Y", "-Y", "start", "end", "+u", "-u", "+v", "-v"]


class Shell(Strict):
    """쉘 (형식 v6): 바깥에서 thickness 만 남기고 비움. open = 열린 면"""

    thickness: Annotated[float, _num(Limits.MIN_DIMENSION, Limits.MAX_DIMENSION / 2)]
    open: Annotated[list[FaceName], Field(max_length=6)]


class BoxObject(_ObjectBase):
    kind: Literal["box"]
    params: BoxParams
    # 없으면 직렬화에서 필드를 뺀다 (Zod 의 optional 과 같은 의미: null 이 아니라 "없음")
    edgeFeature: EdgeFeature | None = Field(default=None, exclude_if=lambda v: v is None)
    shell: Shell | None = _opt()


class CylinderObject(_ObjectBase):
    kind: Literal["cylinder"]
    params: CylinderParams
    shell: Shell | None = _opt()


class SphereObject(_ObjectBase):
    kind: Literal["sphere"]
    params: SphereParams


class ConeObject(_ObjectBase):
    kind: Literal["cone"]
    params: ConeParams


BooleanOperation = Literal["union", "cut", "intersect"]
ToolList = Annotated[list[ObjectId], Field(min_length=1, max_length=Limits.MAX_BOOLEAN_TOOLS)]


class ExtrudeRef(Strict):
    sketch: ObjectId
    profile: ObjectId


class ExtrudeObject(_ObjectBase):
    kind: Literal["extrude"]
    params: ExtrudeParams
    extrude: ExtrudeRef
    shell: Shell | None = _opt()


class RevolveObject(_ObjectBase):
    """회전 (형식 v5): 스케치 프로파일을 스케치 v 축(u = 0) 둘레로 angle 만큼. +u 점이 −w 쪽으로 (CadQuery revolve 와 같음)."""

    kind: Literal["revolve"]
    params: RevolveParams
    revolve: ExtrudeRef


def sketch_feature_ref(obj) -> ExtrudeRef | None:
    """스케치를 참조하는 피처(돌출·회전)의 참조."""
    if isinstance(obj, ExtrudeObject):
        return obj.extrude
    if isinstance(obj, RevolveObject):
        return obj.revolve
    return None


class BooleanDef(Strict):
    operation: BooleanOperation
    base: ObjectId
    tools: ToolList


class BooleanObject(_ObjectBase):
    kind: Literal["boolean"]
    boolean: BooleanDef

    @property
    def child_ids(self) -> list[str]:
        return [self.boolean.base, *self.boolean.tools]


class HoleObject(_ObjectBase):
    kind: Literal["hole"]
    params: HoleParams


Axis = Literal["x", "y", "z"]
PatternCount = Annotated[int, Field(strict=True, ge=1, le=Limits.MAX_PATTERN_COUNT)]
PatternSpacing = Annotated[float, _num(-Limits.MAX_DIMENSION, Limits.MAX_DIMENSION)]


class LinearPattern(Strict):
    type: Literal["linear"]
    source: ObjectId
    axis: Axis
    count: PatternCount
    spacing: PatternSpacing
    axis2: Axis | None = _opt()
    count2: PatternCount | None = _opt()
    spacing2: PatternSpacing | None = _opt()


class CircularPattern(Strict):
    type: Literal["circular"]
    source: ObjectId
    axis: Axis
    count: PatternCount
    angle: Annotated[float, _num(1, 360)]


class MirrorPattern(Strict):
    type: Literal["mirror"]
    source: ObjectId
    plane: Literal["XY", "XZ", "YZ"]
    offset: Coordinate


PatternDef = Annotated[Union[LinearPattern, CircularPattern, MirrorPattern], Field(discriminator="type")]


class PatternObject(_ObjectBase):
    """패턴·대칭 (형식 v6): 결과 = 원본 ∪ 사본. 축·평면은 패턴 좌표계 원점을 지난다"""

    kind: Literal["pattern"]
    pattern: PatternDef

    @property
    def child_ids(self) -> list[str]:
        return [self.pattern.source]


PrimitiveObject = Union[BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject, RevolveObject, HoleObject]
OBJECT_MODELS: tuple[type[_ObjectBase], ...] = (
    BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject, RevolveObject, BooleanObject, HoleObject, PatternObject,
)

CadObject = Annotated[
    Union[BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject, RevolveObject, BooleanObject, HoleObject, PatternObject],
    Field(discriminator="kind"),
]


class ModelDefinition(Strict):
    schemaVersion: Literal[6]
    units: Literal["mm"]
    sketches: Annotated[list[Sketch], Field(max_length=Limits.MAX_SKETCHES)]
    objects: Annotated[list[CadObject], Field(max_length=Limits.MAX_OBJECTS)]


# ---- CAD 명령 ----------------------------------------------------------------


class _CreateBase(Strict):
    id: ObjectId | None = None
    name: Name | None = None
    position: Vec3 | None = None


class CreateBox(_CreateBase):
    type: Literal["create_box"]
    width: Dimension
    depth: Dimension
    height: Dimension


class CreateCylinder(_CreateBase):
    type: Literal["create_cylinder"]
    radius: Radius
    height: Dimension


class CreateSphere(_CreateBase):
    type: Literal["create_sphere"]
    radius: Radius


class CreateCone(_CreateBase):
    type: Literal["create_cone"]
    radiusBottom: RadiusOrZero
    radiusTop: RadiusOrZero
    height: Dimension


class CreateSketch(Strict):
    type: Literal["create_sketch"]
    id: ObjectId | None = None
    name: Name | None = None
    plane: SketchPlane | None = None


class AddRectangle(Strict):
    type: Literal["add_rectangle"]
    sketch: ObjectId
    id: ObjectId | None = None
    center: Point2 | None = None
    width: Dimension
    height: Dimension


class AddCircle(Strict):
    type: Literal["add_circle"]
    sketch: ObjectId
    id: ObjectId | None = None
    center: Point2 | None = None
    diameter: Dimension


class SetDimension(Strict):
    type: Literal["set_dimension"]
    sketch: ObjectId
    dimension: DimensionId
    value: Dimension


class SetEntityCenter(Strict):
    type: Literal["set_entity_center"]
    sketch: ObjectId
    entity: ObjectId
    center: Point2


class DeleteSketchEntity(Strict):
    type: Literal["delete_sketch_entity"]
    sketch: ObjectId
    entity: ObjectId


class SetSketchPlane(Strict):
    type: Literal["set_sketch_plane"]
    sketch: ObjectId
    plane: SketchPlane


class AddPolygon(Strict):
    type: Literal["add_polygon"]
    sketch: ObjectId
    id: ObjectId | None = None
    points: Annotated[list[Point2], Field(min_length=3, max_length=Limits.MAX_POLYGON_POINTS)]


class MovePoint(Strict):
    type: Literal["move_point"]
    sketch: ObjectId
    point: GeomRef
    to: Point2


class AddConstraint(Strict):
    type: Literal["add_constraint"]
    sketch: ObjectId
    id: ObjectId | None = None
    constraint: ConstraintType
    refs: Annotated[list[GeomRef], Field(min_length=1, max_length=2)]
    value: Dimension | None = None


class SetConstraint(Strict):
    type: Literal["set_constraint"]
    sketch: ObjectId
    constraint: ObjectId
    value: Dimension


class DeleteConstraint(Strict):
    type: Literal["delete_constraint"]
    sketch: ObjectId
    constraint: ObjectId


class RenameSketch(Strict):
    type: Literal["rename_sketch"]
    sketch: ObjectId
    name: TrimmedName


class DeleteSketch(Strict):
    type: Literal["delete_sketch"]
    sketch: ObjectId


class Revolve(Strict):
    type: Literal["revolve"]
    id: ObjectId | None = None
    name: Name | None = None
    sketch: ObjectId
    profile: ObjectId
    angle: RevolveAngle | None = None
    position: Vec3 | None = None


class Extrude(Strict):
    type: Literal["extrude"]
    id: ObjectId | None = None
    name: Name | None = None
    sketch: ObjectId
    profile: ObjectId
    distance: ExtrudeDistance
    position: Vec3 | None = None


class _BooleanCommandBase(Strict):
    id: ObjectId | None = None
    name: Name | None = None
    base: ObjectId
    tools: ToolList


class Cut(_BooleanCommandBase):
    type: Literal["cut"]


class Union_(_BooleanCommandBase):
    type: Literal["union"]


class Intersect(_BooleanCommandBase):
    type: Literal["intersect"]


class SetParamsParams(Strict):
    width: Dimension | None = None
    depth: Dimension | None = None
    height: Dimension | None = None
    radius: Radius | None = None
    radiusBottom: RadiusOrZero | None = None
    radiusTop: RadiusOrZero | None = None
    distance: ExtrudeDistance | None = None
    angle: RevolveAngle | None = None
    diameter: Dimension | None = None
    cboreDiameter: RadiusOrZero | None = None
    cboreDepth: RadiusOrZero | None = None
    csinkDiameter: RadiusOrZero | None = None

    @model_validator(mode="after")
    def _not_empty(self) -> SetParamsParams:
        if not self.model_fields_set:
            raise ValueError("변경할 파라미터가 하나 이상 필요합니다")
        return self


class SetParams(Strict):
    type: Literal["set_params"]
    target: ObjectId
    params: SetParamsParams


class Fillet(Strict):
    type: Literal["fillet"]
    target: ObjectId
    radius: Annotated[float, _num(0, Limits.MAX_DIMENSION / 2)]
    edges: EdgeSelection | None = None


class Chamfer(Strict):
    type: Literal["chamfer"]
    target: ObjectId
    distance: Annotated[float, _num(0, Limits.MAX_DIMENSION / 2)]
    edges: EdgeSelection | None = None


class Translate(Strict):
    type: Literal["translate"]
    target: ObjectId
    offset: Vec3


class SetTransform(Strict):
    type: Literal["set_transform"]
    target: ObjectId
    position: Vec3 | None = None
    rotation: Rotation | None = None


class RenameObject(Strict):
    type: Literal["rename_object"]
    target: ObjectId
    name: TrimmedName


class DuplicateObject(Strict):
    type: Literal["duplicate_object"]
    target: ObjectId
    newId: ObjectId | None = None
    offset: Vec3 | None = None


class DeleteObject(Strict):
    type: Literal["delete_object"]
    target: ObjectId


class SetSuppressed(Strict):
    type: Literal["set_suppressed"]
    target: ObjectId
    suppressed: StrictBool


class SetAppearance(Strict):
    type: Literal["set_appearance"]
    target: ObjectId
    color: Color | Literal["default"] | None = None
    hidden: StrictBool | None = None

    @model_validator(mode="after")
    def _something(self) -> SetAppearance:
        if self.color is None and self.hidden is None:
            raise ValueError("color 또는 hidden 이 필요합니다")
        return self


class ShellCommand(Strict):
    type: Literal["shell"]
    target: ObjectId
    thickness: Annotated[float, _num(0, Limits.MAX_DIMENSION / 2)]
    open: Annotated[list[FaceName], Field(max_length=6)] | None = None


class PatternCommand(Strict):
    type: Literal["pattern"]
    id: ObjectId | None = None
    name: Name | None = None
    pattern: PatternDef


class SetPattern(Strict):
    type: Literal["set_pattern"]
    target: ObjectId
    pattern: PatternDef


class HoleCommand(Strict):
    type: Literal["hole"]
    id: ObjectId | None = None
    target: ObjectId
    face: FaceName
    at: Point2
    diameter: Dimension
    depth: Dimension
    cboreDiameter: RadiusOrZero | None = None
    cboreDepth: RadiusOrZero | None = None
    csinkDiameter: RadiusOrZero | None = None


CadCommand = Annotated[
    Union[
        CreateBox,
        CreateCylinder,
        CreateSphere,
        CreateCone,
        CreateSketch,
        AddRectangle,
        AddCircle,
        SetDimension,
        SetEntityCenter,
        DeleteSketchEntity,
        SetSketchPlane,
        AddPolygon,
        MovePoint,
        AddConstraint,
        SetConstraint,
        DeleteConstraint,
        RenameSketch,
        DeleteSketch,
        Extrude,
        Revolve,
        Cut,
        Union_,
        Intersect,
        SetParams,
        Fillet,
        Chamfer,
        Translate,
        SetTransform,
        RenameObject,
        DuplicateObject,
        DeleteObject,
        SetSuppressed,
        SetAppearance,
        ShellCommand,
        PatternCommand,
        SetPattern,
        HoleCommand,
    ],
    Field(discriminator="type"),
]

CadCommandAdapter: TypeAdapter[CadCommand] = TypeAdapter(CadCommand)

COMMAND_MODELS: tuple[type[Strict], ...] = (
    CreateBox,
    CreateCylinder,
    CreateSphere,
    CreateCone,
    CreateSketch,
    AddRectangle,
    AddCircle,
    SetDimension,
    SetEntityCenter,
    DeleteSketchEntity,
    SetSketchPlane,
    AddPolygon,
    MovePoint,
    AddConstraint,
    SetConstraint,
    DeleteConstraint,
    RenameSketch,
    DeleteSketch,
    Extrude,
    Revolve,
    Cut,
    Union_,
    Intersect,
    SetParams,
    Fillet,
    Chamfer,
    Translate,
    SetTransform,
    RenameObject,
    DuplicateObject,
    DeleteObject,
    SetSuppressed,
    SetAppearance,
    ShellCommand,
    PatternCommand,
    SetPattern,
    HoleCommand,
)
