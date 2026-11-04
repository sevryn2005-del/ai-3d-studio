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
from OCP.BRepBuilderAPI import BRepBuilderAPI_GTransform, BRepBuilderAPI_Transform
from OCP.gp import gp_GTrsf, gp_Trsf

from app.cad.commands import (
    ExtrudeObject,
    RevolveObject,
    revolve_profile_error,
    sketch_feature_ref,
    Sketch,
    resolve_profile,
    profile_of,
    open_line_points,
    BooleanObject,
    BoxObject,
    CadObject,
    ConeObject,
    CylinderObject,
    SphereObject,
    Transform,
    HoleObject,
    PatternObject,
    HelixObject,
    LoftObject,
    MeshObject,
    FilletObject,
    DraftObject,
    StepObject,
    SweepObject,
)
from app.cad.features import is_suppressed, pattern_matrices
from app.cad.frames import extrude_local_matrix, sketch_local_matrix
from app.cad.mesh_import import mesh_solid
from app.cad.precise import draft, edge_feature, read_step
from app.cad.sections import helix_error, helix_profile_points, helix_rings, loft_segments, section_points, sweep_profile_points
from app.cad.curves import corner_segments, sweep_error, sweep_rings

import numpy as np

# 헬릭스·로프트 단면 분할 = 출력 허용 오차 (브라우저 엔진은 표시 0.05 / 출력 0.01)
HELIX_TOLERANCE = 0.01

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
            if obj.shell is not None:
                # 쉘: 안쪽 상자(열린 면 쪽은 바깥까지 연장)를 뺀다 — 브라우저 엔진 geometry.ts 와 같은 형상
                t, o = obj.shell.thickness, obj.shell.open
                w, d, h = p.width, p.depth, p.height
                lo = (-w / 2 - 1 if "-X" in o else -w / 2 + t, -d / 2 - 1 if "-Y" in o else -d / 2 + t, -1 if "bottom" in o else t)
                hi = (w / 2 + 1 if "+X" in o else w / 2 - t, d / 2 + 1 if "+Y" in o else d / 2 - t, h + 1 if "top" in o else h - t)
                core = cq.Solid.makeBox(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2], pnt=cq.Vector(*lo))
                return solid.cut(core)
            if f is None:
                return solid
            edges = solid.Edges() if f.edges == "all" else _VERTICAL.filter(solid.Edges())
            try:
                return solid.fillet(f.size, edges) if f.type == "fillet" else solid.chamfer(f.size, None, edges)
            except Exception as e:  # OCCT 실패 → 사용자 메시지
                what = "모서리를 둥글게" if f.type == "fillet" else "모따기를"
                raise GeometryError(f"'{obj.name}': {what} 할 수 없습니다 (크기를 줄여 보세요)") from e
        case CylinderObject(params=p):
            solid = cq.Solid.makeCylinder(p.radius, p.height)
            if obj.shell is None:
                return solid
            t = obj.shell.thickness
            z0 = -1 if "bottom" in obj.shell.open else t
            z1 = p.height + 1 if "top" in obj.shell.open else p.height - t
            return solid.cut(cq.Solid.makeCylinder(p.radius - t, z1 - z0, cq.Vector(0, 0, z0)))
        case HoleObject(params=p):
            # 구멍 도구: 바닥(z 0)~depth 지름 diameter, 위쪽 카운터보어 또는 90° 카운터싱크
            tool = cq.Solid.makeCylinder(p.diameter / 2, p.depth)
            if p.cboreDiameter > 0:
                tool = tool.fuse(cq.Solid.makeCylinder(p.cboreDiameter / 2, p.cboreDepth, cq.Vector(0, 0, p.depth - p.cboreDepth)))
            if p.csinkDiameter > 0:
                ch = (p.csinkDiameter - p.diameter) / 2
                tool = tool.fuse(cq.Solid.makeCone(p.diameter / 2, p.csinkDiameter / 2, ch, cq.Vector(0, 0, p.depth - ch)))
            return tool.clean()
        case SphereObject(params=p):
            return cq.Solid.makeSphere(
                p.radius, cq.Vector(0, 0, p.radius), angleDegrees1=-90, angleDegrees2=90, angleDegrees3=360
            )
        case ConeObject(params=p):
            if abs(p.radiusBottom - p.radiusTop) < 1e-9:
                return cq.Solid.makeCylinder(p.radiusBottom, p.height)
            return cq.Solid.makeCone(p.radiusBottom, p.radiusTop, p.height)
        case BooleanObject() | ExtrudeObject() | RevolveObject() | PatternObject() | HelixObject() | LoftObject() | MeshObject() \
                | FilletObject() | DraftObject() | StepObject() | SweepObject():
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
    p = profile_of(sk, ref) if sk else None
    if p is None:
        raise GeometryError(f"'{obj.name}': 참조한 스케치 프로파일을 찾을 수 없습니다")
    model = SimpleNamespace(objects=list(index.values()), sketches=list(sketches.values()))
    local = extrude_local_matrix(model, obj)  # type: ignore[arg-type]
    if local is None:
        raise GeometryError(f"'{obj.name}': 스케치를 붙인 면을 찾을 수 없습니다")
    def profile_wp() -> cq.Workplane:
        # 작업 평면의 대기 윤곽은 돌출 한 번에 소모되므로, 쓸 때마다 새로 만든다
        if p["type"] == "polygon" and p.get("corners"):  # 꼭짓점 처리: 직선 + 정확한 원호 (curves.py 와 같은 점)
            segs = corner_segments(p["points"], p["corners"], True)
            w = cq.Workplane("XY").moveTo(*segs[0][1])
            for sg in segs:
                w = w.lineTo(*sg[2]) if sg[0] == "line" else w.threePointArc(sg[7], sg[2])
            return w.close()
        if p["type"] == "polygon":  # 꼭짓점 좌표 그대로 (구속 해석기가 푼 값)
            return cq.Workplane("XY").polyline([tuple(q) for q in p["points"]]).close()
        # center() 는 작업 평면 원점을 옮겨 회전축까지 움직이므로 pushPoints 로 단면만 옮긴다
        w = cq.Workplane("XY").pushPoints([tuple(p["center"])])
        if p["type"] == "slot":  # slot2D 길이 = 끝에서 끝 (= 반원 중심 거리 + 폭)
            return w.slot2D(p["length"] + p["width"], p["width"], p["angle"])
        return w.rect(p["width"], p["height"]) if p["type"] == "rectangle" else w.circle(p["diameter"] / 2)

    wp = profile_wp()
    if isinstance(obj, RevolveObject):
        if err := revolve_profile_error(p):
            raise GeometryError(f"'{obj.name}': {err}")
        solid = wp.revolve(obj.params.angle, (0, 0, 0), (0, 1, 0)).val()
    else:
        d = obj.params.distance
        solid = wp.extrude(abs(d)).val()
        if obj.shell is not None:
            # 쉘: 단면을 안쪽으로 줄인(모서리 연장 = intersection) 기둥을 뺀다 — 브라우저 CrossSection.offset(Miter) 와 같음
            t = obj.shell.thickness
            low_open = ("start" if d > 0 else "end") in obj.shell.open
            high_open = ("end" if d > 0 else "start") in obj.shell.open
            z0 = -1 if low_open else t
            z1 = abs(d) + 1 if high_open else abs(d) - t
            try:
                inner = profile_wp().offset2D(-t, kind="intersection").extrude(z1 - z0).val().translate(cq.Vector(0, 0, z0))
            except Exception as e:
                raise GeometryError(f"'{obj.name}': 쉘 두께가 단면보다 큽니다") from e
            solid = solid.cut(inner)
        if d < 0:
            solid = solid.translate(cq.Vector(0, 0, d))
    # 강체 변환(회전+이동)으로 굽는다. cq.Matrix 는 일반 행렬(gp_GTrsf)이라 OCCT 가 거부하므로 gp_Trsf 를 직접 만든다
    trsf = gp_Trsf()
    trsf.SetValues(*local[:3, :4].ravel().tolist())
    return cq.Shape.cast(BRepBuilderAPI_Transform(solid.wrapped, trsf, True).Shape())


def _rigid(shape: cq.Shape, m) -> cq.Shape:
    trsf = gp_Trsf()
    trsf.SetValues(*m[:3, :4].ravel().tolist())
    return cq.Shape.cast(BRepBuilderAPI_Transform(shape.wrapped, trsf, True).Shape())


def _ring_solid(rings, name: str) -> cq.Shape:
    """단면 고리들을 직선(룰드) 면으로 잇기 — 브라우저 ringSolid.ts 와 같은 고리"""
    wires = [cq.Wire.makePolygon([cq.Vector(*p) for p in r], close=True) for r in rings]
    try:
        solid = cq.Solid.makeLoft(wires, ruled=True)
    except Exception as e:
        raise GeometryError(f"'{name}': 단면을 이을 수 없습니다 (단면이 겹치거나 꼬였습니다)") from e
    if solid.Volume() < 0:
        solid = cq.Shape.cast(solid.wrapped.Reversed())
    return solid


def helix_solid(obj: HelixObject, index: dict[str, CadObject], sketches: dict[str, Sketch]) -> cq.Shape:
    sk = sketches.get(obj.helix.sketch)
    p = resolve_profile(sk, obj.helix.profile) if sk else None
    if p is None:
        raise GeometryError(f"'{obj.name}': 참조한 스케치 프로파일을 찾을 수 없습니다")
    pts = helix_profile_points(p, HELIX_TOLERANCE)
    if err := helix_error(pts, obj.params.pitch):
        raise GeometryError(f"'{obj.name}': {err}")
    model = SimpleNamespace(objects=list(index.values()), sketches=list(sketches.values()))
    local = sketch_local_matrix(model, obj.id, obj.helix.sketch)  # type: ignore[arg-type]
    if local is None:
        raise GeometryError(f"'{obj.name}': 스케치를 붙인 면을 찾을 수 없습니다")
    return _rigid(_ring_solid(helix_rings(pts, obj.params.pitch, obj.params.turns, HELIX_TOLERANCE), obj.name), local)


def loft_solid(obj: LoftObject, index: dict[str, CadObject], sketches: dict[str, Sketch]) -> cq.Shape:
    model = SimpleNamespace(objects=list(index.values()), sketches=list(sketches.values()))
    profs = []
    for s in obj.loft.sections:
        sk = sketches.get(s.sketch)
        p = resolve_profile(sk, s.profile) if sk else None
        m = sketch_local_matrix(model, obj.id, s.sketch) if p else None  # type: ignore[arg-type]
        if p is None or m is None:
            raise GeometryError(f"'{obj.name}': 단면 {s.sketch}·{s.profile} 을(를) 찾을 수 없습니다")
        profs.append((p, m))
    n = loft_segments([p for p, _ in profs], HELIX_TOLERANCE)
    rings = []
    for p, m in profs:
        pts = np.array([[u, v, 0.0, 1.0] for u, v in section_points(p, n)])
        rings.append([tuple(q[:3]) for q in (m @ pts.T).T])
    return _ring_solid(rings, obj.name)


def sweep_solid(obj: SweepObject, index: dict[str, CadObject], sketches: dict[str, Sketch]) -> cq.Shape:
    """스윕 (형식 v10): 단면을 경로 시작점에 경로와 수직으로 세우고 마이터로 잇는다 — 브라우저 엔진과 같은 고리 (curves.py)"""
    sk = sketches.get(obj.sweep.sketch)
    pk = sketches.get(obj.sweep.pathSketch)
    p = resolve_profile(sk, obj.sweep.profile) if sk else None
    path = open_line_points(pk, obj.sweep.path) if pk else None
    if p is None or path is None:
        raise GeometryError(f"'{obj.name}': 스윕의 단면 또는 경로를 찾을 수 없습니다")
    prof = sweep_profile_points(p, HELIX_TOLERANCE)
    if err := sweep_error(prof, path):
        raise GeometryError(f"'{obj.name}': {err}")
    model = SimpleNamespace(objects=list(index.values()), sketches=list(sketches.values()))
    m = sketch_local_matrix(model, obj.id, obj.sweep.pathSketch)  # type: ignore[arg-type]
    if m is None:
        raise GeometryError(f"'{obj.name}': 경로 스케치의 평면을 찾을 수 없습니다")
    path3 = [tuple((m @ np.array([u, v, 0.0, 1.0]))[:3]) for u, v in path]
    b = m[:3, 2] / np.linalg.norm(m[:3, 2])
    return _ring_solid(sweep_rings(prof, path3, tuple(b)), obj.name)


def build_solid(obj: CadObject, index: dict[str, CadObject], sketches: dict[str, Sketch] | None = None) -> cq.Shape:
    """객체의 로컬 좌표계 솔리드. 불리언은 자식들을 (부모 기준 변환을 적용해) 재귀적으로 결합한다."""
    sketches = sketches or {}
    if isinstance(obj, HelixObject):
        return helix_solid(obj, index, sketches)
    if isinstance(obj, LoftObject):
        return loft_solid(obj, index, sketches)
    if isinstance(obj, SweepObject):
        return sweep_solid(obj, index, sketches)
    if isinstance(obj, MeshObject):
        return mesh_solid(obj.mesh.positions, obj.mesh.indices, obj.name)
    if isinstance(obj, (ExtrudeObject, RevolveObject)):
        return extrude_solid(obj, index, sketches)

    def placed(child_id: str) -> cq.Shape:
        child = index[child_id]
        return apply_transform(build_solid(child, index, sketches), child.transform)

    if isinstance(obj, PatternObject):
        return pattern_solid(obj, placed(obj.pattern.source))
    if isinstance(obj, StepObject):
        return read_step(obj.step.data, obj.name)
    if isinstance(obj, FilletObject):
        f = obj.fillet
        return edge_feature(placed(f.source), f.type, f.size, f.edges, obj.name)
    if isinstance(obj, DraftObject):
        return draft(placed(obj.draft.source), obj.draft.angle, obj.name)
    if not isinstance(obj, BooleanObject):
        return local_solid(obj)

    result = placed(obj.boolean.base)
    op = obj.boolean.operation
    for tool_id in obj.boolean.tools:
        if is_suppressed(index[tool_id], index):
            continue  # 억제된 도구는 이 연산에서만 빠진다
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


def pattern_solid(obj: PatternObject, src: cq.Shape) -> cq.Shape:
    """패턴·대칭: 원본 ∪ 사본. 대칭은 반사(행렬식 −1)라 강체 변환 대신 mirror 로 만든다."""
    p = obj.pattern
    if p.type == "scale":
        # 일반(비균일) 배율: gp_GTrsf → BRepBuilderAPI_GTransform (균일 배율도 같은 경로)
        g = gp_GTrsf()
        g.SetValue(1, 1, p.x)
        g.SetValue(2, 2, p.y)
        g.SetValue(3, 3, p.z)
        result = cq.Shape.cast(BRepBuilderAPI_GTransform(src.wrapped, g, True).Shape())
        if not result.isValid():
            raise GeometryError(f"'{obj.name}': 크기 조정 결과 형상이 올바르지 않습니다")
        return result
    if p.type == "mirror":
        normal = {"XY": (0, 0, 1), "XZ": (0, 1, 0), "YZ": (1, 0, 0)}[p.plane]
        copies = [src.mirror(p.plane, cq.Vector(*normal) * p.offset)]
    else:
        copies = []
        for m in pattern_matrices(p)[1:]:
            trsf = gp_Trsf()
            trsf.SetValues(*m[:3, :4].ravel().tolist())
            copies.append(cq.Shape.cast(BRepBuilderAPI_Transform(src.wrapped, trsf, True).Shape()))
    result = src.fuse(*copies).clean() if copies else src
    if not result.isValid():
        raise GeometryError(f"'{obj.name}': 패턴 결과 형상이 올바르지 않습니다")
    return result
