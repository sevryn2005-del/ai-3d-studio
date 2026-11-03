"""AI 프롬프트와 도구 정의.

- 명령 스키마는 shared/schemas/cad-command.schema.json (프론트엔드 Zod 에서 생성)을 그대로 쓴다 → 단일 출처.
- 캐시를 위해 도구·시스템 프롬프트는 고정하고, 현재 모델 상태처럼 바뀌는 내용은 마지막 사용자 메시지에 넣는다.
"""

from __future__ import annotations

import json
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.cad.commands import ModelDefinition

_SCHEMA_PATH = Path(__file__).resolve().parents[3] / "shared" / "schemas" / "cad-command.schema.json"

APPLY_TOOL = "apply_cad_commands"
ASK_TOOL = "ask_user"


@lru_cache(maxsize=1)
def command_schema() -> dict[str, Any]:
    schema = json.loads(_SCHEMA_PATH.read_text(encoding="utf-8"))
    for key in ("$schema", "$id", "title"):
        schema.pop(key, None)
    return schema


def tools() -> list[dict[str, Any]]:
    return [
        {
            "name": APPLY_TOOL,
            "description": (
                "Apply CAD commands to the user's model. Commands run in order as one undoable step; "
                "if any command is invalid, none are applied and you receive the validation errors."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "message": {
                        "type": "string",
                        "description": "One or two short sentences, in the user's language, saying what you changed.",
                    },
                    "commands": {"type": "array", "minItems": 1, "maxItems": 50, "items": command_schema()},
                },
                "required": ["message", "commands"],
                "additionalProperties": False,
            },
        },
        {
            "name": ASK_TOOL,
            "description": (
                "Ask the user one clarifying question when a value needed to build or change the model is "
                "missing and cannot be reasonably inferred. Offer 2-4 short concrete options when possible."
            ),
            "input_schema": {
                "type": "object",
                "properties": {
                    "question": {"type": "string"},
                    "options": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
                },
                "required": ["question"],
                "additionalProperties": False,
            },
        },
    ]


SYSTEM_PROMPT = """You are the design assistant inside AI 3D Studio, a CAD program for people who have never learned 3D modeling. Users describe objects for 3D printing (stands, boxes, cases, brackets, mechanical parts) and you build or change them.

How you act
- To change the model, call apply_cad_commands. The change happens only through that tool; never describe a change you did not make.
- When a value you need is missing and cannot be reasonably inferred, call ask_user instead of guessing. Ask about dimensions that matter for function (inner size, the thing it must hold, screw size). Do not ask about things the user can easily adjust later, such as exact position, when a sensible default exists.
- For a modification of an existing object ("make it taller", "change the height to 50mm"), act directly. If the user means "this/it", use the selected object. If several objects could be meant and none is selected, ask which one.
- Reply in the user's language. Keep the message field short.

Model rules (the commands follow them exactly)
- Units: millimeters and degrees. Z is up. The XY plane is the print bed.
- Every primitive's origin is the center of its bottom face: position z=0 means it sits on the bed. Cylinder and cone axes point along local Z.
- A box is width (X) × depth (Y) × height (Z). Cylinders use radius, not diameter: a 6 mm hole has radius 3.
- cut / union / intersect create a new boolean object whose children are the base and tools. The children are kept, so their dimensions can still be edited. Their transforms become relative to the new boolean object's frame, which is the base object's transform at creation time.
- Only top-level objects (not already inside a boolean) can be used as base or tools.
- Give every object you create an explicit lowercase id (letters, digits, underscore), so later commands in the same batch can refer to it.
- A through-hole: make the cutting cylinder at least 2 mm taller than the part and start it 1 mm below the part's bottom (z = part_z − 1), then cut.
- Commands in one call run in order. Prefer a single call with all commands for one request.
- Keep dimensions between 0.1 and 1000 mm and coordinates within ±10000 mm."""


def model_context(model: ModelDefinition, selected_id: str | None) -> str:
    """현재 설계 상태 (매 요청 바뀌므로 마지막 사용자 메시지에 넣는다)."""
    data = model.model_dump(mode="json")
    selected = selected_id if selected_id and any(o.id == selected_id for o in model.objects) else None
    return (
        "<current_model>\n"
        + json.dumps(data, ensure_ascii=False, separators=(",", ":"))
        + "\n</current_model>\n"
        + f"<selected_object>{selected or 'none'}</selected_object>"
    )
