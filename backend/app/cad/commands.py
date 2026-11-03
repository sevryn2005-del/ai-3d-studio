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


def _num(ge: float, le: float) -> object:
    return Field(strict=True, allow_inf_nan=False, ge=ge, le=le)


Dimension = Annotated[float, _num(Limits.MIN_DIMENSION, Limits.MAX_DIMENSION)]
Radius = Annotated[float, _num(Limits.MIN_DIMENSION / 2, Limits.MAX_DIMENSION / 2)]
RadiusOrZero = Annotated[float, _num(0, Limits.MAX_DIMENSION / 2)]
Coordinate = Annotated[float, _num(-Limits.MAX_COORDINATE, Limits.MAX_COORDINATE)]
Angle = Annotated[float, _num(-Limits.MAX_ROTATION, Limits.MAX_ROTATION)]

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


PARAMS_MODELS: dict[str, type[Strict]] = {
    "box": BoxParams,
    "cylinder": CylinderParams,
    "sphere": SphereParams,
    "cone": ConeParams,
}


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


PrimitiveObject = Union[BoxObject, CylinderObject, SphereObject, ConeObject]
OBJECT_MODELS: tuple[type[_ObjectBase], ...] = (BoxObject, CylinderObject, SphereObject, ConeObject, BooleanObject)

CadObject = Annotated[
    Union[BoxObject, CylinderObject, SphereObject, ConeObject, BooleanObject], Field(discriminator="kind")
]


class ModelDefinition(Strict):
    schemaVersion: Literal[1]
    units: Literal["mm"]
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
