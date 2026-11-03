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


PARAMS_MODELS: dict[str, type[Strict]] = {
    "box": BoxParams,
    "cylinder": CylinderParams,
    "sphere": SphereParams,
    "cone": ConeParams,
    "extrude": ExtrudeParams,
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


class _ObjectBase(Strict):
    id: ObjectId
    name: Name
    transform: Transform


EdgeSelection = Literal["all", "vertical"]


class EdgeFeature(Strict):
    """박스 모서리 처리: fillet(size = 반지름) / chamfer(size = 깎는 거리), edges: all | vertical"""

    type: Literal["fillet", "chamfer"]
    size: Annotated[float, _num(Limits.MIN_DIMENSION, Limits.MAX_DIMENSION / 2)]
    edges: EdgeSelection


def max_edge_size(p: BoxParams, edges: str) -> float:
    dims = [p.width, p.depth, p.height] if edges == "all" else [p.width, p.depth]
    return min(dims) / 2


class BoxObject(_ObjectBase):
    kind: Literal["box"]
    params: BoxParams
    # 없으면 직렬화에서 필드를 뺀다 (Zod 의 optional 과 같은 의미: null 이 아니라 "없음")
    edgeFeature: EdgeFeature | None = Field(default=None, exclude_if=lambda v: v is None)


class CylinderObject(_ObjectBase):
    kind: Literal["cylinder"]
    params: CylinderParams


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


PrimitiveObject = Union[BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject]
OBJECT_MODELS: tuple[type[_ObjectBase], ...] = (BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject, BooleanObject)

CadObject = Annotated[
    Union[BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject, BooleanObject], Field(discriminator="kind")
]


class ModelDefinition(Strict):
    schemaVersion: Literal[4]
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
)
