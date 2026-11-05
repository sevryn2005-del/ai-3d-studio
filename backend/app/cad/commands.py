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

import math
from dataclasses import dataclass

from typing import Annotated, Literal, Union

from app.cad.curves import rounded_points, thin_polygon
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
    MAX_LOFT_SECTIONS = 10
    MAX_MESH_TRIANGLES = 200_000


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


HelixTurns = Annotated[float, _num(0.1, 50)]


class HelixParams(Strict):
    """헬릭스 스윕 (형식 v8): 한 바퀴에 pitch 만큼 v 방향으로 오르며 turns 바퀴"""

    pitch: Dimension
    turns: HelixTurns


PARAMS_MODELS: dict[str, type[Strict]] = {
    "box": BoxParams,
    "cylinder": CylinderParams,
    "sphere": SphereParams,
    "cone": ConeParams,
    "extrude": ExtrudeParams,
    "revolve": RevolveParams,
    "hole": HoleParams,
    "helix": HelixParams,
}


# ---- 스케치 (형식 v2) ----------------------------------------------------------------

Point2 = tuple[Coordinate, Coordinate]
DimensionKind = Literal["width", "height", "diameter", "length"]
DimensionId = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-z][a-z0-9_]{0,63}\.(width|height|diameter|length)$")]


class RectangleEntity(Strict):
    id: ObjectId
    type: Literal["rectangle"]
    center: Point2


class CircleEntity(Strict):
    id: ObjectId
    type: Literal["circle"]
    center: Point2


class Corner(Strict):
    """꼭짓점 처리 (형식 v10, 스케치 필렛·모따기) — curves.py"""

    k: Annotated[int, Field(strict=True, ge=0, le=Limits.MAX_POLYGON_POINTS - 1)]
    type: Literal["fillet", "chamfer"]
    size: Annotated[float, _num(Limits.MIN_DIMENSION / 10, Limits.MAX_DIMENSION)]


Corners = Annotated[list[Corner], Field(max_length=Limits.MAX_POLYGON_POINTS)]


class Arc(Strict):
    """변을 호로 (형식 v13): 변 k 의 볼록 정도 bulge = tan(호 각도/4), −1~1 (양수 = 반시계) — curves.py"""

    k: Annotated[int, Field(strict=True, ge=0, le=Limits.MAX_POLYGON_POINTS - 1)]
    bulge: Annotated[float, _num(-1, 1)]


Arcs = Annotated[list[Arc], Field(max_length=Limits.MAX_POLYGON_POINTS)]


class PolygonEntity(Strict):
    """닫힌 다각형 (형식 v4). 꼭짓점 = 구속 해석기가 푼 좌표. 꼭짓점 k = ID.pk, 변 k = ID.ek. corners (v10)."""

    id: ObjectId
    type: Literal["polygon"]
    points: Annotated[list[Point2], Field(min_length=3, max_length=Limits.MAX_POLYGON_POINTS)]
    corners: Corners | None = Field(default=None, exclude_if=lambda v: v is None)
    arcs: Arcs | None = Field(default=None, exclude_if=lambda v: v is None)
    spline: Literal[True] | None = Field(default=None, exclude_if=lambda v: v is None)


class PathEntity(Strict):
    """경로 (형식 v10): 열린 꺾은선. 꼭짓점 ID.pk, 변 ID.ek (닫히지 않음). 안쪽 꼭짓점 corners."""

    id: ObjectId
    type: Literal["path"]
    points: Annotated[list[Point2], Field(min_length=2, max_length=Limits.MAX_POLYGON_POINTS)]
    corners: Corners | None = Field(default=None, exclude_if=lambda v: v is None)
    arcs: Arcs | None = Field(default=None, exclude_if=lambda v: v is None)
    spline: Literal[True] | None = Field(default=None, exclude_if=lambda v: v is None)


class LineEntity(Strict):
    """구성선 (형식 v7): 형상 없음, 구속 기준. 끝점 ID.p0·ID.p1, 변 ID.e0"""

    id: ObjectId
    type: Literal["line"]
    points: tuple[Point2, Point2]


SketchAngle = Annotated[float, _num(-360, 360)]


class SlotEntity(Strict):
    """슬롯 (형식 v7): 치수 ID.length(반원 중심 거리)·ID.width(폭), 방향 angle(°)"""

    id: ObjectId
    type: Literal["slot"]
    center: Point2
    angle: SketchAngle


class RegionItem(Strict):
    entity: ObjectId
    op: Literal["add", "subtract"]


MAX_REGION_ITEMS = 20
RegionItems = Annotated[list[RegionItem], Field(min_length=1, max_length=MAX_REGION_ITEMS)]


class RegionEntity(Strict):
    """영역 (형식 v15): 닫힌 요소를 순서대로 합치고(add) 빼서(subtract) 만든 단면. 첫 항목은 add (sketch.ts regionError)"""

    id: ObjectId
    type: Literal["region"]
    items: RegionItems


SketchEntity = Annotated[
    Union[RectangleEntity, CircleEntity, PolygonEntity, LineEntity, SlotEntity, PathEntity, RegionEntity], Field(discriminator="type")
]

ConstraintType = Literal[
    "fix", "coincident", "concentric", "horizontal", "vertical", "parallel", "perpendicular", "equal", "length", "distance", "tangent",
    "angle", "symmetric",
]
GeomRef = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-z][a-z0-9_]{0,63}(\.(p|e)\d{1,2}|\.center)?$")]


class SketchConstraint(Strict):
    """기하 구속 (frontend/src/cad/solver.ts). 값은 length·distance 만."""

    id: ObjectId
    type: ConstraintType
    refs: Annotated[list[GeomRef], Field(min_length=1, max_length=3)]
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


class AngledPlane(Strict):
    """각도 기준 평면 (형식 v7): base 를 그 평면의 u/v 축 둘레로 angle 만큼 돌리고 새 법선으로 offset"""

    type: Literal["angled"]
    base: Literal["XY", "XZ", "YZ"]
    axis: Literal["u", "v"]
    angle: SketchAngle
    offset: Coordinate


class FramePlane(Strict):
    """고른 면 평면 (형식 v12): 월드 원점·법선·u 방향 + 법선 방향 offset (객체를 따라가지 않음)"""

    type: Literal["frame"]
    origin: Vec3
    normal: Vec3
    xDir: Vec3
    offset: Coordinate


SketchPlane = Annotated[Union[StandardPlane, FacePlane, AngledPlane, FramePlane], Field(discriminator="type")]


class Sketch(Strict):
    id: ObjectId
    name: Annotated[str, StringConstraints(strict=True, min_length=1, max_length=100)]
    plane: SketchPlane
    entities: Annotated[list[SketchEntity], Field(max_length=Limits.MAX_SKETCH_ENTITIES)]
    dimensions: Annotated[list[SketchDimension], Field(max_length=Limits.MAX_SKETCH_ENTITIES * 2)]
    constraints: Annotated[list[SketchConstraint], Field(max_length=Limits.MAX_SKETCH_CONSTRAINTS)]


REQUIRED_DIMENSIONS = {"rectangle": ("width", "height"), "circle": ("diameter",), "polygon": (), "line": (), "slot": ("length", "width"), "path": (), "region": ()}


def slot_half_extent(p: dict) -> tuple[float, float]:
    a = math.radians(p["angle"])
    r = p["width"] / 2
    return abs(math.cos(a)) * p["length"] / 2 + r, abs(math.sin(a)) * p["length"] / 2 + r


def revolve_profile_error(p: dict) -> str | None:
    """회전 프로파일이 축(u = 0)의 한쪽(u ≥ 0)에 있는지 (frontend sketch.ts revolveProfileError 와 같음)."""
    if p["type"] == "region":  # 합치는 단면들만 본다 (빼기는 줄이기만 한다)
        return next((e for it in p["items"] if it["op"] == "add" and (e := revolve_profile_error(it["profile"]))), None)
    if p["type"] == "polygon":
        min_u = min(q[0] for q in rounded_points(p["points"], p.get("corners"), True, p.get("arcs"), bool(p.get("spline"))))
    elif p["type"] == "circle":
        min_u = p["center"][0] - p["diameter"] / 2
    elif p["type"] == "slot":
        min_u = p["center"][0] - slot_half_extent(p)[0]
    else:
        min_u = p["center"][0] - p["width"] / 2
    if min_u < -1e-9:
        return f"회전 프로파일은 회전축(스케치 v 축, u = 0)의 한쪽(u ≥ 0)에 있어야 합니다 (지금 u 최소 {round(min_u, 3)})"
    return None


def _polygon_profile(points, corners, z, plane, arcs=None, spline=None) -> dict:
    """다각형 단면 (sketch.ts polygonProfile 과 같음): 중심·크기 = 꼭짓점 처리·호 변 뒤 윤곽의 바운딩 박스"""
    outline = rounded_points(points, corners, True, arcs, bool(spline))
    xs = [p[0] for p in outline]
    ys = [p[1] for p in outline]
    out = {"type": "polygon", "points": [tuple(p) for p in points], "center": ((min(xs) + max(xs)) / 2, (min(ys) + max(ys)) / 2),
           "width": max(xs) - min(xs), "height": max(ys) - min(ys), "z": z, "plane": plane}
    if corners:
        out["corners"] = [c.model_dump() if hasattr(c, "model_dump") else c for c in corners]
    if arcs:
        out["arcs"] = [a.model_dump() if hasattr(a, "model_dump") else a for a in arcs]
    if spline:
        out["spline"] = True
    return out


def open_line_points(sketch: Sketch, entity_id: str) -> list | None:
    """열린 선(구성선·경로)의 점 — 경로의 둥근 꺾임은 윤곽 표본으로 (sketch.ts openLinePoints)"""
    e = next((x for x in sketch.entities if x.id == entity_id), None)
    if e is None or e.type not in ("line", "path"):
        return None
    if e.type == "path":
        return rounded_points(e.points, e.corners, False, e.arcs, bool(e.spline))
    return rounded_points(e.points, None, False)


def profile_of(sketch: Sketch, ref) -> dict | None:
    """참조의 단면: thin 이면 열린 선을 두께만큼 띄운 다각형 (sketch.ts profileOf)"""
    thin = getattr(ref, "thin", None)
    if thin is None:
        return resolve_profile(sketch, ref.profile)
    pts = open_line_points(sketch, ref.profile)
    if pts is None:
        return None
    return _polygon_profile(thin_polygon(pts, thin), None, sketch.plane.offset, sketch.plane)


CLOSED_TYPES = ("rectangle", "circle", "polygon", "slot")


def region_error(sketch: Sketch, items, self_id: str | None = None) -> str | None:
    """영역 구성 규칙 (sketch.ts regionError 와 같음)"""
    if not items:
        return "영역에 요소가 없습니다"
    if items[0].op != "add":
        return "영역의 첫 요소는 합치기(add)여야 합니다"
    seen: set[str] = set()
    for it in items:
        if it.entity == self_id:
            return "영역이 자기 자신을 참조합니다"
        if it.entity in seen:
            return f"영역에 {it.entity} 이(가) 두 번 들어 있습니다"
        seen.add(it.entity)
        e = next((x for x in sketch.entities if x.id == it.entity), None)
        if e is None:
            return f"영역의 요소 {it.entity} 이(가) 없습니다"
        if e.type not in CLOSED_TYPES:
            return f"영역에는 닫힌 요소(사각형·원·다각형·슬롯)만 넣을 수 있습니다: {it.entity}"
    return None


def profile_bounds(p: dict) -> tuple[float, float, float, float]:
    """(u0, v0, u1, v1) — sketch.ts profileBounds"""
    if p["type"] == "circle":
        r = p["diameter"] / 2
        return p["center"][0] - r, p["center"][1] - r, p["center"][0] + r, p["center"][1] + r
    if p["type"] == "slot":
        hu, hv = slot_half_extent(p)
        return p["center"][0] - hu, p["center"][1] - hv, p["center"][0] + hu, p["center"][1] + hv
    cx, cy = p["center"]
    return cx - p["width"] / 2, cy - p["height"] / 2, cx + p["width"] / 2, cy + p["height"] / 2


def resolve_profile(sketch: Sketch, entity_id: str) -> dict | None:
    """돌출 단면 (프론트엔드 cad/sketch.ts 의 resolveProfile 과 같은 규칙)."""
    e = next((x for x in sketch.entities if x.id == entity_id), None)
    if e is None or e.type in ("line", "path"):
        return None
    dims = {d.kind: d.value for d in sketch.dimensions if d.entity == e.id}
    z = sketch.plane.offset
    if e.type == "region":
        if region_error(sketch, e.items, e.id):
            return None
        items = [{"op": it.op, "profile": resolve_profile(sketch, it.entity)} for it in e.items]
        if any(it["profile"] is None for it in items):
            return None
        bs = [profile_bounds(it["profile"]) for it in items if it["op"] == "add"]
        u0, v0 = min(b[0] for b in bs), min(b[1] for b in bs)
        u1, v1 = max(b[2] for b in bs), max(b[3] for b in bs)
        return {"type": "region", "items": items, "center": ((u0 + u1) / 2, (v0 + v1) / 2), "width": u1 - u0, "height": v1 - v0,
                "z": z, "plane": sketch.plane}
    if e.type == "polygon":
        return _polygon_profile(e.points, e.corners, z, sketch.plane, e.arcs, e.spline)
    if e.type == "rectangle":
        if "width" in dims and "height" in dims:
            return {"type": "rectangle", "center": e.center, "width": dims["width"], "height": dims["height"], "z": z,
                    "plane": sketch.plane}
        return None
    if e.type == "slot":
        if "length" in dims and "width" in dims:
            return {"type": "slot", "center": e.center, "length": dims["length"], "width": dims["width"], "angle": e.angle, "z": z,
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


class ThinExtrudeRef(ExtrudeRef):
    """돌출 참조 (형식 v10: thin = 리브·얇은 돌출 두께, 열린 선 참조)"""

    thin: Annotated[float | None, Field(exclude_if=lambda v: v is None)] = None


class ExtrudeObject(_ObjectBase):
    kind: Literal["extrude"]
    params: ExtrudeParams
    extrude: ThinExtrudeRef
    shell: Shell | None = _opt()


class RevolveObject(_ObjectBase):
    """회전 (형식 v5): 스케치 프로파일을 스케치 v 축(u = 0) 둘레로 angle 만큼. +u 점이 −w 쪽으로 (CadQuery revolve 와 같음)."""

    kind: Literal["revolve"]
    params: RevolveParams
    revolve: ExtrudeRef


class HelixObject(_ObjectBase):
    kind: Literal["helix"]
    params: HelixParams
    helix: ExtrudeRef


class LoftDef(Strict):
    sections: Annotated[list[ExtrudeRef], Field(min_length=2, max_length=Limits.MAX_LOFT_SECTIONS)]


class LoftObject(_ObjectBase):
    """로프트 (형식 v8): 단면들을 같은 점 수로 나눠 직선 면으로 잇는다 (sections.py)"""

    kind: Literal["loft"]
    loft: LoftDef


MeshBase64 = Annotated[str, StringConstraints(strict=True, max_length=16_000_000, pattern=r"^[A-Za-z0-9+/]*={0,2}$")]


class SweepDef(Strict):
    sketch: ObjectId
    profile: ObjectId
    pathSketch: ObjectId
    path: ObjectId


class SweepObject(_ObjectBase):
    """스윕 (형식 v10): 단면을 경로를 따라 (curves.py sweep_rings)"""

    kind: Literal["sweep"]
    sweep: SweepDef


class MeshData(Strict):
    positions: MeshBase64
    indices: MeshBase64


class MeshObject(_ObjectBase):
    """가져온 메시 (형식 v8): Float32/Uint32 리틀엔디안 base64 (mesh_import.py)"""

    kind: Literal["mesh"]
    mesh: MeshData


def sketch_feature_ref(obj) -> ExtrudeRef | None:
    """스케치 하나를 참조하는 피처(돌출·회전·헬릭스)의 참조."""
    if isinstance(obj, ExtrudeObject):
        return obj.extrude
    if isinstance(obj, RevolveObject):
        return obj.revolve
    if isinstance(obj, HelixObject):
        return obj.helix
    return None


@dataclass(frozen=True)
class FeatureRef:
    """sketch.ts FeatureRef: open = 열린 선(스윕 경로) 참조"""

    sketch: str
    profile: str
    thin: float | None = None
    open: bool = False


def sketch_refs(obj) -> list:
    """객체가 참조하는 모든 스케치 요소 (로프트 = 단면 여러 개, 스윕 = 단면 + 경로)"""
    if isinstance(obj, LoftObject):
        return list(obj.loft.sections)
    if isinstance(obj, SweepObject):
        return [FeatureRef(obj.sweep.sketch, obj.sweep.profile), FeatureRef(obj.sweep.pathSketch, obj.sweep.path, open=True)]
    r = sketch_feature_ref(obj)
    return [r] if r else []


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


ScaleFactor = Annotated[float, _num(0.01, 100)]


class ScalePattern(Strict):
    """크기 조정 (형식 v7): 패턴 원점 기준 축별 배율, 원본 하나"""

    type: Literal["scale"]
    source: ObjectId
    x: ScaleFactor
    y: ScaleFactor
    z: ScaleFactor


class MirrorPattern(Strict):
    type: Literal["mirror"]
    source: ObjectId
    plane: Literal["XY", "XZ", "YZ"]
    offset: Coordinate


PatternDef = Annotated[Union[LinearPattern, CircularPattern, MirrorPattern, ScalePattern], Field(discriminator="type")]


class PatternObject(_ObjectBase):
    """패턴·대칭 (형식 v6): 결과 = 원본 ∪ 사본. 축·평면은 패턴 좌표계 원점을 지난다"""

    kind: Literal["pattern"]
    pattern: PatternDef

    @property
    def child_ids(self) -> list[str]:
        return [self.pattern.source]


EdgeRule = Literal["all", "vertical", "top", "bottom"]


class EdgePicks(Strict):
    """화면에서 고른 모서리 위의 점들 (형식 v12, 피처 좌표계) — precise.select_edges"""

    at: Annotated[list[Vec3], Field(min_length=1, max_length=200)]


FeatureEdges = Union[EdgeRule, EdgePicks]
FeatureType = Literal["fillet", "chamfer"]
DraftAngle = Annotated[float, _num(-30, 30)]


class FilletDef(Strict):
    source: ObjectId
    type: FeatureType
    size: Radius
    edges: FeatureEdges


class FilletObject(_ObjectBase):
    """모서리 처리 (형식 v9, 정밀 엔진): 원본 형상의 모서리를 규칙(edges)으로 골라 필렛·모따기 (precise.py)"""

    kind: Literal["fillet"]
    fillet: FilletDef

    @property
    def child_ids(self) -> list[str]:
        return [self.fillet.source]


class DraftDef(Strict):
    source: ObjectId
    angle: DraftAngle


class DraftObject(_ObjectBase):
    """구배 (형식 v9): 세로 면을 바닥 높이 기준으로 기울인다. 양수 = 위로 갈수록 안쪽"""

    kind: Literal["draft"]
    draft: DraftDef

    @property
    def child_ids(self) -> list[str]:
        return [self.draft.source]


class StepData(Strict):
    data: MeshBase64


class StepObject(_ObjectBase):
    """가져온 STEP (형식 v9): 파일 내용 base64. 바운딩 박스 바닥면 중심을 원점으로 옮긴다"""

    kind: Literal["step"]
    step: StepData


PrimitiveObject = Union[BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject, RevolveObject, HoleObject, HelixObject]
OBJECT_MODELS: tuple[type[_ObjectBase], ...] = (
    BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject, RevolveObject, BooleanObject, HoleObject, PatternObject,
    HelixObject, LoftObject, MeshObject, FilletObject, DraftObject, StepObject, SweepObject,
)

CadObject = Annotated[
    Union[BoxObject, CylinderObject, SphereObject, ConeObject, ExtrudeObject, RevolveObject, BooleanObject, HoleObject, PatternObject,
          HelixObject, LoftObject, MeshObject, FilletObject, DraftObject, StepObject, SweepObject],
    Field(discriminator="kind"),
]


MateType = Literal["coincident", "distance", "parallel", "perpendicular", "angle", "concentric", "fix"]
MateRef = Annotated[str, StringConstraints(strict=True, pattern=r"^[a-z][a-z0-9_]{0,63}(\.(top|bottom|\+X|-X|\+Y|-Y|start|end|\+u|-u|\+v|-v|axis))?$")]
MAX_MATES = 200


class MateRefCaptured(Strict):
    """화면에서 고른 이름 없는 면·축 (형식 v12): 부품 로컬 원점·방향"""

    object: ObjectId
    kind: Literal["face", "axis"]
    origin: Vec3
    dir: Vec3


MateRefAny = Union[MateRef, MateRefCaptured]


class Mate(Strict):
    """조립 메이트 (형식 v11) — mates.py"""

    id: ObjectId
    type: MateType
    refs: Annotated[list[MateRefAny], Field(min_length=1, max_length=2)]
    value: Annotated[Coordinate | None, Field(exclude_if=lambda v: v is None)] = None
    flip: Annotated[StrictBool | None, Field(exclude_if=lambda v: v is None)] = None


DrawingViewName = Literal["front", "top", "right", "iso"]


class DrawingSection(Strict):
    """전단면도 (형식 v14): 정면도 = 평면 y = offset(앞쪽을 걷어냄), 우측면도 = 평면 x = offset(오른쪽을 걷어냄)"""

    view: Literal["front", "right"]
    offset: Coordinate


class DrawingAnchor(Strict):
    """사용자 치수 끝점 (형식 v17): at = 보기 평면 좌표, rel = 보기 범위 안 상대 위치 — frontend features/drawing/dims.ts 가 다시 붙인다"""

    at: tuple[Coordinate, Coordinate]
    rel: tuple[Annotated[float, _num(-10, 11)], Annotated[float, _num(-10, 11)]]


class DrawingDim(Strict):
    """사용자 치수 (형식 v17): 수평·수직·평행(a·b) 또는 지름(a = 원 중심). offset = 종이 mm"""

    id: ObjectId
    view: Literal["front", "top", "right"]
    kind: Literal["horizontal", "vertical", "aligned", "diameter"]
    a: DrawingAnchor
    b: Annotated[DrawingAnchor | None, Field(exclude_if=lambda v: v is None)] = None
    offset: Annotated[float, _num(-200, 200)]


MAX_DRAWING_DIMS = 100


class DrawingSettings(Strict):
    """도면 설정 (형식 v14) — frontend commandTypes.ts DrawingSettingsSchema. 형상에는 영향 없음"""

    paper: Literal["A4", "A3"]
    scale: Literal["auto"] | Annotated[float, _num(0.0001, 100)]
    title: Annotated[str | None, Field(max_length=80, exclude_if=lambda v: v is None)] = None
    views: Annotated[list[DrawingViewName], Field(max_length=4)]
    dimensions: StrictBool
    centerlines: StrictBool
    section: Annotated[DrawingSection | None, Field(exclude_if=lambda v: v is None)] = None
    notes: Annotated[str | None, Field(max_length=500, exclude_if=lambda v: v is None)] = None
    dims: Annotated[list[DrawingDim] | None, Field(max_length=MAX_DRAWING_DIMS, exclude_if=lambda v: v is None)] = None


class ModelDefinition(Strict):
    schemaVersion: Literal[17]
    units: Literal["mm"]
    sketches: Annotated[list[Sketch], Field(max_length=Limits.MAX_SKETCHES)]
    objects: Annotated[list[CadObject], Field(max_length=Limits.MAX_OBJECTS)]
    mates: Annotated[list[Mate] | None, Field(max_length=MAX_MATES, exclude_if=lambda v: v is None)] = None
    drawing: Annotated[DrawingSettings | None, Field(exclude_if=lambda v: v is None)] = None


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


class AddPath(Strict):
    type: Literal["add_path"]
    sketch: ObjectId
    id: ObjectId | None = None
    points: Annotated[list[Point2], Field(min_length=2, max_length=Limits.MAX_POLYGON_POINTS)]


class SetCorner(Strict):
    type: Literal["set_corner"]
    sketch: ObjectId
    entity: ObjectId
    vertices: Annotated[list[Annotated[int, Field(strict=True, ge=0, le=Limits.MAX_POLYGON_POINTS - 1)]],
                        Field(max_length=Limits.MAX_POLYGON_POINTS)] | None = None
    corner: Literal["fillet", "chamfer"]
    size: Annotated[float, _num(0, Limits.MAX_DIMENSION)]


class SetArc(Strict):
    """변을 호로 (형식 v13): 다각형·경로의 변 edge 를 볼록 정도 bulge 의 원호로 (0 = 직선)"""

    type: Literal["set_arc"]
    sketch: ObjectId
    entity: ObjectId
    edge: Annotated[int, Field(strict=True, ge=0, le=Limits.MAX_POLYGON_POINTS - 1)]
    bulge: Annotated[float, _num(-1, 1)]


class SetSpline(Strict):
    """스플라인 켜기·끄기 (형식 v16): 다각형·경로의 점들을 지나는 매끈한 곡선"""

    type: Literal["set_spline"]
    sketch: ObjectId
    entity: ObjectId
    spline: StrictBool


class AddRegion(Strict):
    """영역 단면 추가 (형식 v15)"""

    type: Literal["add_region"]
    sketch: ObjectId
    id: ObjectId | None = None
    items: RegionItems


class SetRegion(Strict):
    type: Literal["set_region"]
    sketch: ObjectId
    entity: ObjectId
    items: RegionItems


class ConvertToPolygon(Strict):
    """사각형 → 같은 모양의 다각형 (형식 v13)"""

    type: Literal["convert_to_polygon"]
    sketch: ObjectId
    entity: ObjectId


class SweepCommand(Strict):
    type: Literal["sweep"]
    id: ObjectId | None = None
    name: Name | None = None
    sketch: ObjectId
    profile: ObjectId
    pathSketch: ObjectId
    path: ObjectId


class SetThin(Strict):
    type: Literal["set_thin"]
    target: ObjectId
    thin: Dimension


class AddMate(Strict):
    type: Literal["add_mate"]
    id: ObjectId | None = None
    mate: MateType
    refs: Annotated[list[MateRefAny], Field(min_length=1, max_length=2)]
    value: Coordinate | None = None
    flip: StrictBool | None = None


class SetMate(Strict):
    type: Literal["set_mate"]
    mate: ObjectId
    value: Coordinate | None = None
    flip: StrictBool | None = None


class DeleteMate(Strict):
    type: Literal["delete_mate"]
    mate: ObjectId


class SetDrawing(Strict):
    """도면 설정 바꾸기 (형식 v14): 설정 전체를 바꾼다"""

    type: Literal["set_drawing"]
    drawing: DrawingSettings


class PartData(Strict):
    sketches: Annotated[list[Sketch], Field(max_length=Limits.MAX_SKETCHES)]
    objects: Annotated[list[CadObject], Field(min_length=1, max_length=Limits.MAX_OBJECTS)]


class InsertPart(Strict):
    type: Literal["insert_part"]
    name: Name
    part: PartData
    position: Vec3 | None = None


class AddLine(Strict):
    type: Literal["add_line"]
    sketch: ObjectId
    id: ObjectId | None = None
    points: tuple[Point2, Point2]


class AddSlot(Strict):
    type: Literal["add_slot"]
    sketch: ObjectId
    id: ObjectId | None = None
    center: Point2 | None = None
    length: Dimension
    width: Dimension
    angle: SketchAngle | None = None


class SetEntityAngle(Strict):
    type: Literal["set_entity_angle"]
    sketch: ObjectId
    entity: ObjectId
    angle: SketchAngle


class OffsetEntity(Strict):
    type: Literal["offset_entity"]
    sketch: ObjectId
    entity: ObjectId
    id: ObjectId | None = None
    distance: Annotated[float, _num(-Limits.MAX_DIMENSION, Limits.MAX_DIMENSION)]


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
    refs: Annotated[list[GeomRef], Field(min_length=1, max_length=3)]
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


class Helix(Strict):
    type: Literal["helix"]
    id: ObjectId | None = None
    name: Name | None = None
    sketch: ObjectId
    profile: ObjectId
    pitch: Dimension
    turns: HelixTurns


class Loft(Strict):
    type: Literal["loft"]
    id: ObjectId | None = None
    name: Name | None = None
    sections: Annotated[list[ExtrudeRef], Field(min_length=2, max_length=Limits.MAX_LOFT_SECTIONS)]


class ImportMesh(Strict):
    type: Literal["import_mesh"]
    id: ObjectId | None = None
    name: Name | None = None
    positions: MeshBase64
    indices: MeshBase64
    position: Vec3 | None = None


class EdgeFeatureCommand(Strict):
    type: Literal["edge_feature"]
    id: ObjectId | None = None
    name: Name | None = None
    target: ObjectId
    feature: FeatureType
    size: Radius
    edges: FeatureEdges


class SetEdgeFeature(Strict):
    type: Literal["set_edge_feature"]
    target: ObjectId
    feature: FeatureType | None = None
    size: Radius | None = None
    edges: FeatureEdges | None = None


class DraftCommand(Strict):
    type: Literal["draft"]
    id: ObjectId | None = None
    name: Name | None = None
    target: ObjectId
    angle: DraftAngle


class SetDraft(Strict):
    type: Literal["set_draft"]
    target: ObjectId
    angle: DraftAngle


class ImportStep(Strict):
    type: Literal["import_step"]
    id: ObjectId | None = None
    name: Name | None = None
    data: MeshBase64
    position: Vec3 | None = None


class Extrude(Strict):
    type: Literal["extrude"]
    id: ObjectId | None = None
    name: Name | None = None
    sketch: ObjectId
    profile: ObjectId
    distance: ExtrudeDistance
    position: Vec3 | None = None
    thin: Dimension | None = None


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
    pitch: Dimension | None = None
    turns: HelixTurns | None = None

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
        AddLine,
        AddPath,
        SetCorner,
        SetArc,
        ConvertToPolygon,
        AddRegion,
        SetRegion,
        SetSpline,
        AddSlot,
        SetEntityAngle,
        OffsetEntity,
        MovePoint,
        AddConstraint,
        SetConstraint,
        DeleteConstraint,
        RenameSketch,
        DeleteSketch,
        Extrude,
        Revolve,
        Helix,
        Loft,
        SweepCommand,
        SetThin,
        AddMate,
        SetMate,
        DeleteMate,
        SetDrawing,
        InsertPart,
        ImportMesh,
        EdgeFeatureCommand,
        SetEdgeFeature,
        DraftCommand,
        SetDraft,
        ImportStep,
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
    AddLine,
    AddPath,
    SetCorner,
    SetArc,
    ConvertToPolygon,
    AddRegion,
    SetRegion,
    SetSpline,
    AddSlot,
    SetEntityAngle,
    OffsetEntity,
    MovePoint,
    AddConstraint,
    SetConstraint,
    DeleteConstraint,
    RenameSketch,
    DeleteSketch,
    Extrude,
    Revolve,
    Helix,
    Loft,
    SweepCommand,
    SetThin,
    AddMate,
    SetMate,
    DeleteMate,
    SetDrawing,
    InsertPart,
    ImportMesh,
    EdgeFeatureCommand,
    SetEdgeFeature,
    DraftCommand,
    SetDraft,
    ImportStep,
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
