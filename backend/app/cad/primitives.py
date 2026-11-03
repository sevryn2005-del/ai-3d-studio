"""설계 원본(ModelDefinition)의 객체 → CadQuery/OCCT 솔리드.

규칙 (frontend/src/cad/commandTypes.ts 와 동일)
- 단위 mm, Z-up.
- 모든 기본 도형의 로컬 원점 = 바운딩 박스 바닥면 중심. 원통·원뿔 축 = 로컬 Z.
- 변환: 회전(XYZ 오일러, degree) 후 이동. 회전 행렬은 Three.js Euler 'XYZ' 와 같은 Rx·Ry·Rz
  → 월드 축 기준으로 Z, Y, X 순서로 회전하는 것과 같다.

OCCT 주의 사항 (실험으로 확인)
- makeCone 은 위·아래 반지름이 같으면 Standard_DomainError → 원통으로 생성한다.
- makeSphere 의 기본 각도 범위는 반구이므로 -90°~90° 를 명시한다.
"""

from __future__ import annotations

from types import SimpleNamespace

import cadquery as cq
from OCP.BRepBuilderAPI import BRepBuilderAPI_Transform
from OCP.gp import gp_Trsf

from app.cad.commands import (
    ExtrudeObject,
    RevolveObject,
    revolve_profile_error,
    sketch_feature_ref,
    Sketch,
    resolve_profile,
    BooleanObject,
    BoxObject,
    CadObject,
    ConeObject,
    CylinderObject,
    SphereObject,
    Transform,
)
from app.cad.frames import extrude_local_matrix

_ORIGIN = cq.Vector(0, 0, 0)
_VERTICAL = cq.selectors.ParallelDirSelector(cq.Vector(0, 0, 1))
_AXES = {"x": cq.Vector(1, 0, 0), "y": cq.Vector(0, 1, 0), "z": cq.Vector(0, 0, 1)}


class GeometryError(Exception):
    """형상 생성 실패. 메시지는 사용자에게 보여줄 수 있는 한국어."""


def local_solid(obj: CadObject) -> cq.Shape:
    """변환을 적용하지 않은 로컬 좌표계의 솔리드."""
    match obj:
        case BoxObject(params=p, edgeFeature=f):
            solid = cq.Solid.makeBox(p.width, p.depth, p.height, pnt=cq.Vector(-p.width / 2, -p.depth / 2, 0))
            if f is None:
                return solid
            edges = solid.Edges() if f.edges == "all" else _VERTICAL.filter(solid.Edges())
            try:
                return solid.fillet(f.size, edges) if f.type == "fillet" else solid.chamfer(f.size, None, edges)
            except Exception as e:  # OCCT 실패 → 사용자 메시지
                what = "모서리를 둥글게" if f.type == "fillet" else "모따기를"
                raise GeometryError(f"'{obj.name}': {what} 할 수 없습니다 (크기를 줄여 보세요)") from e
        case CylinderObject(params=p):
            return cq.Solid.makeCylinder(p.radius, p.height)
        case SphereObject(params=p):
            return cq.Solid.makeSphere(
                p.radius, cq.Vector(0, 0, p.radius), angleDegrees1=-90, angleDegrees2=90, angleDegrees3=360
            )
        case ConeObject(params=p):
            if abs(p.radiusBottom - p.radiusTop) < 1e-9:
                return cq.Solid.makeCylinder(p.radiusBottom, p.height)
            return cq.Solid.makeCone(p.radiusBottom, p.radiusTop, p.height)
        case BooleanObject() | ExtrudeObject() | RevolveObject():
            raise GeometryError("불리언·돌출 객체는 build_solid 로 계산해야 합니다")
    raise GeometryError(f"지원하지 않는 도형입니다: {obj.kind}")


def apply_transform(shape: cq.Shape, t: Transform) -> cq.Shape:
    rx, ry, rz = t.rotation
    # Three.js Euler XYZ: v' = Rx·Ry·Rz·v → 월드 축 기준 Z → Y → X 순서
    for axis, deg in (("z", rz), ("y", ry), ("x", rx)):
        if deg:
            shape = shape.rotate(_ORIGIN, _AXES[axis], deg)
    if any(t.position):
        shape = shape.translate(cq.Vector(*t.position))
    return shape


def world_solid(obj: CadObject) -> cq.Shape:
    return apply_transform(local_solid(obj), obj.transform)


_OPERATION_LABEL = {"cut": "빼기", "union": "합치기", "intersect": "교차"}


def extrude_solid(obj: ExtrudeObject | RevolveObject, index: dict[str, CadObject], sketches: dict[str, Sketch]) -> cq.Shape:
    """스케치 피처 (객체 로컬 좌표). 평면 좌표에서 단면을 돌출(또는 v 축 둘레 회전)한 뒤 frames.extrude_local_matrix 로 옮긴다
    — 기준 평면·면 평면 모두 브라우저 엔진 geometry.ts / sketchPlane.ts 와 같은 행렬.
    음수 거리는 평면 법선 반대쪽. 회전은 Y(= v) 축 둘레 오른손 규칙: +u 점이 −w 쪽으로."""
    ref = sketch_feature_ref(obj)
    sk = sketches.get(ref.sketch)
    p = resolve_profile(sk, ref.profile) if sk else None
    if p is None:
        raise GeometryError(f"'{obj.name}': 참조한 스케치 프로파일을 찾을 수 없습니다")
    model = SimpleNamespace(objects=list(index.values()), sketches=list(sketches.values()))
    local = extrude_local_matrix(model, obj)  # type: ignore[arg-type]
    if local is None:
        raise GeometryError(f"'{obj.name}': 스케치를 붙인 면을 찾을 수 없습니다")
    if p["type"] == "polygon":  # 꼭짓점 좌표 그대로 (구속 해석기가 푼 값)
        wp = cq.Workplane("XY").polyline([tuple(q) for q in p["points"]]).close()
    else:
        # center() 는 작업 평면 원점을 옮겨 회전축까지 움직이므로 pushPoints 로 단면만 옮긴다
        wp = cq.Workplane("XY").pushPoints([tuple(p["center"])])
        wp = wp.rect(p["width"], p["height"]) if p["type"] == "rectangle" else wp.circle(p["diameter"] / 2)
    if isinstance(obj, RevolveObject):
        if err := revolve_profile_error(p):
            raise GeometryError(f"'{obj.name}': {err}")
        solid = wp.revolve(obj.params.angle, (0, 0, 0), (0, 1, 0)).val()
    else:
        d = obj.params.distance
        solid = wp.extrude(abs(d)).val()
        if d < 0:
            solid = solid.translate(cq.Vector(0, 0, d))
    # 강체 변환(회전+이동)으로 굽는다. cq.Matrix 는 일반 행렬(gp_GTrsf)이라 OCCT 가 거부하므로 gp_Trsf 를 직접 만든다
    trsf = gp_Trsf()
    trsf.SetValues(*local[:3, :4].ravel().tolist())
    return cq.Shape.cast(BRepBuilderAPI_Transform(solid.wrapped, trsf, True).Shape())


def build_solid(obj: CadObject, index: dict[str, CadObject], sketches: dict[str, Sketch] | None = None) -> cq.Shape:
    """객체의 로컬 좌표계 솔리드. 불리언은 자식들을 (부모 기준 변환을 적용해) 재귀적으로 결합한다."""
    sketches = sketches or {}
    if isinstance(obj, (ExtrudeObject, RevolveObject)):
        return extrude_solid(obj, index, sketches)
    if not isinstance(obj, BooleanObject):
        return local_solid(obj)

    def placed(child_id: str) -> cq.Shape:
        child = index[child_id]
        return apply_transform(build_solid(child, index, sketches), child.transform)

    result = placed(obj.boolean.base)
    op = obj.boolean.operation
    for tool_id in obj.boolean.tools:
        tool = placed(tool_id)
        if op == "cut":
            result = result.cut(tool)
        elif op == "union":
            result = result.fuse(tool)
        else:
            result = result.intersect(tool)
    if op == "union":
        result = result.clean()  # 합친 면 사이의 불필요한 경계선 제거

    if not result.Solids():
        raise GeometryError(f"'{obj.name}': {_OPERATION_LABEL[op]} 결과가 비어 있습니다 (겹치는 부분이 없습니다)")
    if not result.isValid():
        raise GeometryError(f"'{obj.name}': {_OPERATION_LABEL[op]} 결과 형상이 올바르지 않습니다")
    return result
