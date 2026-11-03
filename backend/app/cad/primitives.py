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

import cadquery as cq

from app.cad.commands import (
    BooleanObject,
    BoxObject,
    CadObject,
    ConeObject,
    CylinderObject,
    SphereObject,
    Transform,
)

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
        case BooleanObject():
            raise GeometryError("불리언 객체는 build_solid 로 계산해야 합니다")
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


def build_solid(obj: CadObject, index: dict[str, CadObject]) -> cq.Shape:
    """객체의 로컬 좌표계 솔리드. 불리언은 자식들을 (부모 기준 변환을 적용해) 재귀적으로 결합한다."""
    if not isinstance(obj, BooleanObject):
        return local_solid(obj)

    def placed(child_id: str) -> cq.Shape:
        child = index[child_id]
        return apply_transform(build_solid(child, index), child.transform)

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
