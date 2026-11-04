"""가져온 메시 (형식 v8): base64 Float32/Uint32 리틀엔디안 → OCCT 솔리드 (frontend/src/cad/meshData.ts 와 같은 형식).

OCCT 는 삼각형마다 면을 만들어 꿰매므로 느리다 → 서버 엔진은 MAX_SERVER_MESH_TRIANGLES 까지.
더 큰 메시는 브라우저 엔진(manifold)이 그대로 다룬다.
"""

from __future__ import annotations

import base64

import cadquery as cq
import numpy as np
from OCP.BRepBuilderAPI import BRepBuilderAPI_MakeFace, BRepBuilderAPI_MakePolygon, BRepBuilderAPI_MakeSolid, BRepBuilderAPI_Sewing
from OCP.gp import gp_Pnt
from OCP.ShapeFix import ShapeFix_Solid
from OCP.TopAbs import TopAbs_SHELL
from OCP.TopoDS import TopoDS

MAX_SERVER_MESH_TRIANGLES = 20_000


def decode(positions: str, indices: str) -> tuple[np.ndarray, np.ndarray]:
    v = np.frombuffer(base64.b64decode(positions), dtype="<f4").astype(np.float64).reshape(-1, 3)
    t = np.frombuffer(base64.b64decode(indices), dtype="<u4").astype(np.int64).reshape(-1, 3)
    return v, t


def mesh_error(positions: str, indices: str, max_triangles: int) -> str | None:
    try:
        v, t = decode(positions, indices)
    except Exception:
        return "메시 데이터가 올바르지 않습니다"
    if len(t) < 4:
        return "메시 삼각형이 4개 이상이어야 합니다"
    if len(t) > max_triangles:
        return f"메시 삼각형은 최대 {max_triangles:,}개까지 가능합니다"
    if t.size and t.max() >= len(v):
        return "메시 삼각형이 없는 정점을 가리킵니다"
    if not np.isfinite(v).all() or np.abs(v).max() > 10_000:
        return "메시 좌표가 허용 범위를 벗어납니다"
    return None


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
