"""가져온 메시 (형식 v8): base64 Float32/Uint32 리틀엔디안 → OCCT 솔리드 (frontend/src/cad/meshData.ts 와 같은 형식).

OCCT 는 삼각형마다 면을 만들어 꿰매므로 느리다 → 서버 엔진은 MAX_SERVER_MESH_TRIANGLES 까지.
더 큰 메시는 브라우저 엔진(manifold)이 그대로 다룬다.
"""

from __future__ import annotations

import cadquery as cq
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.gp import gp_Pnt
from OCP.ShapeFix import ShapeFix_Solid
from OCP.TopAbs import TopAbs_SHELL
from OCP.TopoDS import TopoDS

from app.cad.mesh_data import decode, mesh_error  # noqa: F401  (mesh_error 재노출)

MAX_SERVER_MESH_TRIANGLES = 20_000


def mesh_solid(positions: str, indices: str, name: str) -> cq.Shape:
    from app.cad.primitives import GeometryError

    v, t = decode(positions, indices)
    if len(t) > MAX_SERVER_MESH_TRIANGLES:
        raise GeometryError(f"'{name}': 서버(CadQuery) 엔진은 삼각형 {MAX_SERVER_MESH_TRIANGLES:,}개까지 가져온 메시를 다룹니다. "
                            "브라우저 엔진을 쓰거나 메시를 줄이세요")
    sew = BRepBuilderAPI_Sewing(1e-6)
    for a, b, c in t:
        poly = BRepBuilderAPI_MakePolygon(gp_Pnt(*v[a]), gp_Pnt(*v[b]), gp_Pnt(*v[c]), True)
        if poly.IsDone():
            face = BRepBuilderAPI_MakeFace(poly.Wire(), True)
            if face.IsDone():
                sew.Add(face.Face())
    sew.Perform()
    sewed = sew.SewedShape()
    if sewed.ShapeType() != TopAbs_SHELL:
        raise GeometryError(f"'{name}': 가져온 메시가 닫혀 있지 않습니다 (구멍·떨어진 모서리)")
    solid = BRepBuilderAPI_MakeSolid(TopoDS.Shell_s(sewed)).Solid()
    fix = ShapeFix_Solid(solid)
    fix.Perform()
    shape = cq.Shape.cast(fix.Solid())
    if shape.Volume() <= 0:
        raise GeometryError(f"'{name}': 가져온 메시의 안팎(면 방향)이 뒤집혀 있습니다")
    return shape
