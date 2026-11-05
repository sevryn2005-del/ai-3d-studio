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
