"""편집 메시 (형식 v20, 3D 모델링 모드) — 서버 검증. 형상 계산은 공유 픽스처(test_features.py)가 검사한다."""

import copy

from app.cad.commands import ModelDefinition
from app.cad.validation import check_model

from .conftest import load_json

CASE = load_json("examples/feature-cases.json")["polymesh-cube-extrude"]["model"]


def test_valid_polymesh_model():
    assert check_model(ModelDefinition.model_validate(CASE)) == []


def test_face_pointing_to_missing_vertex_is_rejected():
    model = copy.deepcopy(CASE)
    model["objects"][0]["polymesh"]["faces"][0][0] = 9999
    issues = check_model(ModelDefinition.model_validate(model))
    assert [i.path for i in issues] == ["objects.0.polymesh"]
    assert "없는 점" in issues[0].message


def test_repeated_vertex_in_face_is_rejected():
    model = copy.deepcopy(CASE)
    f = model["objects"][0]["polymesh"]["faces"][0]
    f[1] = f[0]
    assert "같은 점" in check_model(ModelDefinition.model_validate(model))[0].message


def _volume(verts, faces) -> float:
    v = 0.0
    for f in faces:
        for i in range(1, len(f) - 1):
            a, b, c = verts[f[0]], verts[f[i]], verts[f[i + 1]]
            v += (a[0] * (b[1] * c[2] - b[2] * c[1]) - a[1] * (b[0] * c[2] - b[2] * c[0]) + a[2] * (b[0] * c[1] - b[1] * c[0])) / 6
    return v


def test_modifier_stack_matches_frontend_exactly():
    """형식 v22: 서버 polymesh.py 가 프론트 polymeshModifiers.ts 와 같은 점을 만든다 (세분 표면 부피가 소수 6자리까지 같음)"""
    from app.cad.polymesh import evaluate

    case = load_json("examples/feature-cases.json")["polymesh-subsurf"]
    obj = case["model"]["objects"][0]
    verts, faces = evaluate(obj["polymesh"]["verts"], obj["polymesh"]["faces"], obj["modifiers"])
    assert len(faces) == 96
    assert abs(_volume(verts, faces) - case["volume"]) < 1e-6


def test_mirror_merge_closes_half_and_solidify_closes_plane():
    from app.cad.polymesh import evaluate

    half = [(0, -1, -1), (1, -1, -1), (1, 1, -1), (0, 1, -1), (0, -1, 1), (1, -1, 1), (1, 1, 1), (0, 1, 1)]
    faces = [[0, 3, 2, 1], [4, 5, 6, 7], [0, 1, 5, 4], [1, 2, 6, 5], [2, 3, 7, 6]]  # x = 0 쪽 면 없음 (열림)
    v, f = evaluate(half, faces, [{"type": "mirror", "axis": "x", "merge": True}])
    assert abs(_volume(v, f) - 8) < 1e-9
    v, f = evaluate([(-1, -1, 0), (1, -1, 0), (1, 1, 0), (-1, 1, 0)], [[0, 1, 2, 3]], [{"type": "solidify", "thickness": 0.5}])
    assert abs(_volume(v, f) - 2) < 1e-9


def test_smooth_decimate_match_frontend_exactly():
    """형식 v31: 매끈하게·면 줄이기가 프론트와 같은 점을 만든다 (공유 픽스처 부피가 소수 6자리까지 같음)"""
    from app.cad.polymesh import evaluate

    case = load_json("examples/feature-cases.json")["polymesh-smooth-decimate"]
    obj = case["model"]["objects"][0]
    verts, faces = evaluate(obj["polymesh"]["verts"], obj["polymesh"]["faces"], obj["modifiers"])
    assert all(len(f) == 3 for f in faces) and len(faces) < 192
    assert abs(_volume(verts, faces) - case["volume"]) < 1e-6


def test_smooth_cube_and_decimate_keeps_open_border():
    from app.cad.polymesh import evaluate

    cube = [(x, y, z) for z in (-10, 10) for y in (-10, 10) for x in (-10, 10)]
    v, _ = evaluate(cube, [[0, 2, 3, 1], [4, 5, 7, 6], [0, 1, 5, 4], [1, 3, 7, 5], [3, 2, 6, 7], [2, 0, 4, 6]], [{"type": "smooth", "factor": 0.5, "repeat": 1}])
    assert all(abs(abs(c) - 6.666667) < 1e-9 for p in v for c in p)
    n = 6
    grid = [(x * 4.0 - 12, y * 4.0 - 12, 0.0) for y in range(n + 1) for x in range(n + 1)]
    quads = [[y * (n + 1) + x, y * (n + 1) + x + 1, (y + 1) * (n + 1) + x + 1, (y + 1) * (n + 1) + x] for y in range(n) for x in range(n)]
    v, f = evaluate(grid, quads, [{"type": "decimate", "ratio": 0.3}])
    border = [p for p in v if abs(abs(p[0]) - 12) < 1e-9 or abs(abs(p[1]) - 12) < 1e-9]
    assert len(border) == 4 * n and len(f) < 2 * n * n
