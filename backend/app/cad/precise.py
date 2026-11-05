"""형식 v9 정밀 피처: 모서리 필렛·모따기(규칙 선택), 구배, STEP 가져오기.

브라우저 정밀 엔진 frontend/src/features/engine/occt/occtGeometry.ts 와 같은 OCCT 호출·같은 규칙:
- 모서리 규칙(all·vertical·top·bottom)은 감싸는 피처 좌표계(원본에 원본 변환을 적용한 뒤)에서 고른다.
  이음선(한 면에 두 번 붙은 모서리)과 퇴화 모서리는 제외. 판정 오차 1e-4mm, 바운딩 박스는 정확한 곡선 기준(AddOptimal).
- 구배: 옆면(법선이 수평인 평면, 축이 Z 와 나란한 원통면)을 바닥(z 최소) 중립면 기준으로 +Z 방향 각도만큼. 양수 = 위로 갈수록 안쪽.
- STEP: 바운딩 박스 바닥면 중심을 원점으로 옮긴다 (가져온 메시와 같은 원점 규칙).
"""

from __future__ import annotations

import base64
import math
import os
import tempfile

import cadquery as cq
from OCP.Bnd import Bnd_Box
from OCP.BRep import BRep_Tool
from OCP.BRepAdaptor import BRepAdaptor_Surface
from OCP.BRepBndLib import BRepBndLib
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeVertex
from OCP.BRepCheck import BRepCheck_Analyzer
from OCP.BRepExtrema import BRepExtrema_DistShapeShape
from OCP.BRepFilletAPI import BRepFilletAPI_MakeChamfer, BRepFilletAPI_MakeFillet
from OCP.BRepOffsetAPI import BRepOffsetAPI_DraftAngle
from OCP.GeomAbs import GeomAbs_Cylinder, GeomAbs_Plane
from OCP.gp import gp_Dir, gp_Pln, gp_Pnt
from OCP.IFSelect import IFSelect_RetDone
from OCP.STEPControl import STEPControl_Reader
from OCP.TopAbs import TopAbs_EDGE, TopAbs_FACE
from OCP.TopExp import TopExp_Explorer
from OCP.TopoDS import TopoDS, TopoDS_Edge, TopoDS_Face, TopoDS_Shape

EPS = 1e-4
PICK_TOLERANCE = 1e-3  # 고른 점이 모서리 위에 있다고 보는 거리 — occtGeometry.ts PICK_TOLERANCE 와 같음
EdgeRule = object  # "all" | "vertical" | "top" | "bottom" | EdgePicks(at=[...])


def _bounds(s: TopoDS_Shape) -> tuple[float, float, float, float, float, float]:
    b = Bnd_Box()
    BRepBndLib.AddOptimal_s(s, b, False, False)
    return b.Get()


def _explore(s: TopoDS_Shape, kind) -> list[TopoDS_Shape]:
    ex = TopExp_Explorer(s, kind)
    out = []
    while ex.More():
        out.append(ex.Current())
        ex.Next()
    return out


def select_edges(s: TopoDS_Shape, rule: EdgeRule) -> list[TopoDS_Edge]:
    """규칙에 맞는 모서리 (중복·이음선·퇴화 모서리 제외). 고른 점(at)이면 각 점을 지나는 모서리"""
    _, _, zmin, _, _, zmax = _bounds(s)
    skip: list[TopoDS_Edge] = []
    for f in _explore(s, TopAbs_FACE):
        face = TopoDS.Face_s(f)
        for e in _explore(face, TopAbs_EDGE):
            edge = TopoDS.Edge_s(e)
            if BRep_Tool.IsClosed_s(edge, face):
                skip.append(edge)
    kept: list[TopoDS_Edge] = []
    for e in _explore(s, TopAbs_EDGE):
        edge = TopoDS.Edge_s(e)
        if BRep_Tool.Degenerated_s(edge) or any(x.IsSame(edge) for x in skip) or any(x.IsSame(edge) for x in kept):
            continue
        if not isinstance(rule, str):
            kept.append(edge)
            continue
        x0, y0, z0, x1, y1, z1 = _bounds(edge)
        if rule == "all":
            ok = True
        elif rule == "top":
            ok = abs(z0 - zmax) < EPS and abs(z1 - zmax) < EPS
        elif rule == "bottom":
            ok = abs(z0 - zmin) < EPS and abs(z1 - zmin) < EPS
        else:  # vertical
            ok = x1 - x0 < EPS and y1 - y0 < EPS and z1 - z0 > EPS
        if ok:
            kept.append(edge)
    if isinstance(rule, str):
        return kept
    from app.cad.primitives import GeometryError

    picked: set[int] = set()
    for p in rule.at:
        v = BRepBuilderAPI_MakeVertex(gp_Pnt(*p)).Vertex()
        hits = [i for i, e in enumerate(kept) if (d := BRepExtrema_DistShapeShape(v, e)).IsDone() and d.Value() < PICK_TOLERANCE]
        if not hits:
            raise GeometryError(f"고른 모서리 ({', '.join(f'{q:.2f}' for q in p)}) 를 찾을 수 없습니다. 형상이 바뀌었으면 모서리를 다시 고르세요")
        picked.update(hits)
    return [e for i, e in enumerate(kept) if i in picked]


def draft_faces(s: TopoDS_Shape) -> list[TopoDS_Face]:
    out = []
    for f in _explore(s, TopAbs_FACE):
        face = TopoDS.Face_s(f)
        a = BRepAdaptor_Surface(face, True)
        t = a.GetType()
        if t == GeomAbs_Plane:
            if abs(a.Plane().Axis().Direction().Z()) < 1e-9:
                out.append(face)
        elif t == GeomAbs_Cylinder:
            d = a.Cylinder().Axis().Direction()
            if abs(d.X()) < 1e-9 and abs(d.Y()) < 1e-9:
                out.append(face)
    return out


def _valid(s: TopoDS_Shape) -> bool:
    return BRepCheck_Analyzer(s, True, False).IsValid()


def edge_feature(shape: cq.Shape, kind: str, size: float, rule: EdgeRule, name: str) -> cq.Shape:
    from app.cad.primitives import GeometryError

    s = shape.wrapped
    edges = select_edges(s, rule)
    if not edges:
        raise GeometryError(f"'{name}': 규칙에 맞는 모서리가 없습니다")
    what = "모서리를 둥글게" if kind == "fillet" else "모따기를"
    try:
        mk = BRepFilletAPI_MakeFillet(s) if kind == "fillet" else BRepFilletAPI_MakeChamfer(s)
        for e in edges:
            mk.Add(size, e)
        mk.Build()
        if not mk.IsDone():
            raise RuntimeError("fillet")
        result = mk.Shape()
        out = cq.Shape.cast(result)
        if not _valid(result) or out.Volume() <= 0:
            raise RuntimeError("invalid")
        return out
    except Exception as e:
        raise GeometryError(f"'{name}': {what} 할 수 없습니다 (크기를 줄여 보세요)") from e


def draft(shape: cq.Shape, angle: float, name: str) -> cq.Shape:
    from app.cad.primitives import GeometryError

    if abs(angle) < 1e-9:
        return shape
    s = shape.wrapped
    faces = draft_faces(s)
    if not faces:
        raise GeometryError(f"'{name}': 구배를 줄 옆면(수직 평면·원통면)이 없습니다")
    zmin = _bounds(s)[2]
    pln = gp_Pln(gp_Pnt(0, 0, zmin), gp_Dir(0, 0, 1))
    up = gp_Dir(0, 0, 1)
    try:
        dr = BRepOffsetAPI_DraftAngle(s)
        for f in faces:
            dr.Add(f, up, math.radians(angle), pln, True)
            if not dr.AddDone():
                raise RuntimeError("draft add")
        dr.Build()
        if not dr.IsDone():
            raise RuntimeError("draft")
        result = dr.Shape()
        if not _valid(result):
            raise RuntimeError("invalid")
        return cq.Shape.cast(result)
    except Exception as e:
        raise GeometryError(f"'{name}': 구배를 줄 수 없습니다 (구배는 필렛·모따기보다 먼저 주세요. 또는 각도를 줄여 보세요)") from e


def read_step(data: str, name: str) -> cq.Shape:
    """STEP(base64) → 원점(바운딩 박스 바닥면 중심)에 맞춘 형상"""
    from app.cad.primitives import GeometryError

    fd, path = tempfile.mkstemp(suffix=".step")
    try:
        with os.fdopen(fd, "wb") as f:
            f.write(base64.b64decode(data))
        r = STEPControl_Reader()
        if r.ReadFile(path) != IFSelect_RetDone:
            raise GeometryError(f"'{name}': STEP 파일을 읽을 수 없습니다")
        r.TransferRoots()
        if r.NbShapes() < 1:
            raise GeometryError(f"'{name}': STEP 파일에 형상이 없습니다")
        shape = cq.Shape.cast(r.OneShape())
    except GeometryError:
        raise
    except Exception as e:
        raise GeometryError(f"'{name}': STEP 파일을 읽을 수 없습니다") from e
    finally:
        os.unlink(path)
    if not shape.Solids():
        raise GeometryError(f"'{name}': STEP 파일에 솔리드가 없습니다 (곡면·선만 있는 파일은 지원하지 않습니다)")
    x0, y0, z0, x1, y1, _ = _bounds(shape.wrapped)
    return shape.translate(cq.Vector(-(x0 + x1) / 2, -(y0 + y1) / 2, -z0))
