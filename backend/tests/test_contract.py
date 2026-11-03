"""프론트엔드(Zod) ↔ 공유 JSON Schema ↔ 백엔드(Pydantic) 계약 테스트.

세 검증기가 같은 예제에 같은 판정을 내리고, 명령/필드 구성이 일치하는지 검사한다.
Zod 쪽 판정은 frontend/scripts/schemas.test.ts 가 같은 예제로 검사한다.
"""

import jsonschema
import pytest
from pydantic import ValidationError

from app.cad.commands import COMMAND_MODELS, CadCommandAdapter, ModelDefinition

from .conftest import load_json

COMMAND_SCHEMA = load_json("cad-command.schema.json")
MODEL_SCHEMA = load_json("model-definition.schema.json")
VALID = load_json("examples/cad-commands.valid.json")
INVALID = load_json("examples/cad-commands.invalid.json")

json_validator = jsonschema.Draft202012Validator(COMMAND_SCHEMA)


def test_shared_schemas_are_valid_json_schema():
    jsonschema.Draft202012Validator.check_schema(COMMAND_SCHEMA)
    jsonschema.Draft202012Validator.check_schema(MODEL_SCHEMA)


@pytest.mark.parametrize("command", VALID, ids=lambda c: c["type"])
def test_valid_examples_pass_everywhere(command):
    assert json_validator.is_valid(command)
    CadCommandAdapter.validate_python(command)


@pytest.mark.parametrize("case", INVALID, ids=lambda c: c["reason"])
def test_invalid_examples_fail_everywhere(case):
    assert not json_validator.is_valid(case["command"]), "JSON Schema 가 통과시킴"
    with pytest.raises(ValidationError):
        CadCommandAdapter.validate_python(case["command"])


def _schema_commands() -> dict[str, dict]:
    return {s["properties"]["type"]["const"]: s for s in COMMAND_SCHEMA["oneOf"]}


def test_same_command_types():
    pydantic_types = [m.model_fields["type"].annotation.__args__[0] for m in COMMAND_MODELS]
    assert pydantic_types == list(_schema_commands())


@pytest.mark.parametrize("model", COMMAND_MODELS, ids=lambda m: m.__name__)
def test_same_fields_and_required(model):
    """각 명령의 필드 이름과 필수 여부가 JSON Schema 와 같다."""
    type_name = model.model_fields["type"].annotation.__args__[0]
    schema = _schema_commands()[type_name]
    assert set(model.model_fields) == set(schema["properties"])
    required = {n for n, f in model.model_fields.items() if f.is_required()}
    assert required == set(schema.get("required", []))
    assert schema.get("additionalProperties") is False


def test_model_definition_roundtrip(default_model):
    jsonschema.validate(default_model, MODEL_SCHEMA)
    assert ModelDefinition.model_validate(default_model).model_dump(mode="json") == default_model


def test_cone_rule_in_model_definition(default_model):
    """JSON Schema 로 표현되지 않는 교차 규칙은 Pydantic 이 잡는다 (Zod 와 동일)."""
    default_model["objects"][0] = {
        "id": "cone_1",
        "name": "원뿔",
        "kind": "cone",
        "params": {"radiusBottom": 0, "radiusTop": 0, "height": 10},
        "transform": {"position": [0, 0, 0], "rotation": [0, 0, 0]},
    }
    with pytest.raises(ValidationError, match="반지름 중 하나는"):
        ModelDefinition.model_validate(default_model)
