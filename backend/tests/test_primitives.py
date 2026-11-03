"""ModelDefinition → CadQuery 솔리드: 치수가 정확히 반영되는지 검증."""

import math

import numpy as np
import pytest

from app.cad.commands import CadObject
from app.cad.primitives import local_solid, world_solid
from pydantic import TypeAdapter

ObjectAdapter = TypeAdapter(CadObject)
TOL = 1e-6


def obj(kind: str, params: dict, position=(0, 0, 0), rotation=(0, 0, 0)):
    return ObjectAdapter.validate_python(
        {
            "id": f"{kind}_1",
            "name": kind,
            "kind": kind,
            "params": params,
            "transform": {"position": list(position), "rotation": list(rotation)},
        }
    )


def bbox(shape):
    b = shape.BoundingBox()
    return np.array([b.xmin, b.ymin, b.zmin, b.xmax, b.ymax, b.zmax])


@pytest.mark.parametrize(
    "kind,params,size,volume",
    [
        ("box", {"width": 80, "depth": 50, "height": 30}, (80, 50, 30), 80 * 50 * 30),
        ("cylinder", {"radius": 5, "height": 30}, (10, 10, 30), math.pi * 25 * 30),
        ("sphere", {"radius": 10}, (20, 20, 20), 4 / 3 * math.pi * 1000),
        ("cone", {"radiusBottom": 10, "radiusTop": 0, "height": 20}, (20, 20, 20), math.pi * 20 * 100 / 3),
        ("cone", {"radiusBottom": 0, "radiusTop": 10, "height": 20}, (20, 20, 20), math.pi * 20 * 100 / 3),
        ("cone", {"radiusBottom": 10, "radiusTop": 4, "height": 20}, (20, 20, 20), math.pi * 20 * (100 + 40 + 16) / 3),
        # OCCT makeCone 은 같은 반지름에서 실패 → 원통으로 생성되어야 함
        ("cone", {"radiusBottom": 6, "radiusTop": 6, "height": 10}, (12, 12, 10), math.pi * 36 * 10),
    ],
)
def test_dimensions_and_origin_rule(kind, params, size, volume):
    s = local_solid(obj(kind, params))
    assert s.isValid()
    sx, sy, sz = size
    # 원점 = 바운딩 박스 바닥면 중심
    np.testing.assert_allclose(bbox(s), [-sx / 2, -sy / 2, 0, sx / 2, sy / 2, sz], atol=1e-4)
    assert s.Volume() == pytest.approx(volume, rel=1e-6)


def test_height_50_is_exact():
    """첫 번째 목표: '높이를 50mm로' → 실제 형상의 높이가 정확히 50mm."""
    s = local_solid(obj("box", {"width": 20, "depth": 20, "height": 50}))
    b = s.BoundingBox()
    assert b.zlen == pytest.approx(50, abs=TOL)


def test_translation():
    s = world_solid(obj("box", {"width": 10, "depth": 10, "height": 10}, position=(30, -5, 2)))
    np.testing.assert_allclose(bbox(s), [25, -10, 2, 35, 0, 12], atol=1e-6)


def _three_euler_xyz(rx, ry, rz):
    """Three.js Matrix4.makeRotationFromEuler(order='XYZ') 와 같은 회전 행렬 = Rx·Ry·Rz."""
    a, b, c = (math.radians(v) for v in (rx, ry, rz))
    Rx = np.array([[1, 0, 0], [0, math.cos(a), -math.sin(a)], [0, math.sin(a), math.cos(a)]])
    Ry = np.array([[math.cos(b), 0, math.sin(b)], [0, 1, 0], [-math.sin(b), 0, math.cos(b)]])
    Rz = np.array([[math.cos(c), -math.sin(c), 0], [math.sin(c), math.cos(c), 0], [0, 0, 1]])
    return Rx @ Ry @ Rz


@pytest.mark.parametrize("rotation", [(0, 0, 45), (30, 0, 0), (0, 60, 0), (15, -30, 45), (90, 90, 90)])
def test_rotation_matches_threejs(rotation):
    """화면(Three.js)과 출력물(CadQuery)의 회전이 같아야 한다: 박스 꼭짓점 위치 비교."""
    w, d, h = 40, 20, 10
    position = np.array([5, 7, 3])
    s = world_solid(obj("box", {"width": w, "depth": d, "height": h}, position=position, rotation=rotation))
    R = _three_euler_xyz(*rotation)
    corners = [np.array([x, y, z]) for x in (-w / 2, w / 2) for y in (-d / 2, d / 2) for z in (0, h)]
    expected = sorted(tuple(np.round(R @ c + position, 6)) for c in corners)
    actual = sorted(tuple(np.round(v.toTuple(), 6)) for v in (vv.Center() for vv in s.Vertices()))
    np.testing.assert_allclose(actual, expected, atol=1e-6)
