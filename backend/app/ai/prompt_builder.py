"""AI 프롬프트와 도구 정의.

- 명령 스키마는 shared/schemas/cad-command.schema.json (프론트엔드 Zod 에서 생성)을 그대로 쓴다 → 단일 출처.
- 캐시를 위해 도구·시스템 프롬프트는 고정하고, 현재 모델 상태처럼 바뀌는 내용은 마지막 사용자 메시지에 넣는다.
"""

from __future__ import annotations

import json
import sys
from functools import lru_cache
from pathlib import Path
from typing import Any

from app.cad.commands import ModelDefinition

def _schema_path() -> Path:
    """저장소에서는 shared/schemas, PyInstaller 묶음(데스크톱 앱)에서는 묶음 안의 shared/schemas."""
    bundle = getattr(sys, "_MEIPASS", None)
    root = Path(bundle) if bundle else Path(__file__).resolve().parents[3]
    return root / "shared" / "schemas" / "cad-command.schema.json"


_SCHEMA_PATH = _schema_path()

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
- Give every object and sketch you create an explicit lowercase id (letters, digits, underscore), so later commands in the same batch can refer to it.
- fillet (round) and chamfer (bevel) work on boxes only. edges "all" = all 12 edges, "vertical" = the 4 vertical edges (good for a smooth top-down outline). The size must be less than half of the shortest side involved (all: min of width/depth/height; vertical: min of width/depth). Size 0 removes it. To round a hollowed box, fillet the outer box before cutting.
- Sketches: create_sketch makes a 2D sketch on a plane: XY (u=X, v=Y, extrudes toward +Z), XZ (u=X, v=Z, extrudes toward −Y) or YZ (u=Y, v=Z, extrudes toward +X); plane.offset moves the plane along that extrude direction. Default XY at offset 0. add_rectangle (center, width along u, height along v) and add_circle (center, diameter) add profiles; each value is stored as a named dimension "<element id>.width|height|diameter". extrude turns one profile into a solid object (kind "extrude") of thickness distance, starting at the sketch plane. Use sketch + extrude for flat parts such as plates, and give sketches and elements explicit ids.
- To change a sketched part's outline, use set_dimension on the sketch (e.g. sketch "sk_plate", dimension "r1.width"); its extrude objects follow. To change the thickness, use set_params with distance on the extrude object. Sketches and objects share one id namespace. set_entity_center moves a sketch element (e.g. a hole); delete_sketch_entity / delete_sketch only work when no extrude uses them, so delete those extrude objects first.
- Sketch on a face of an existing object: plane {"type": "face", "object": "<id>", "face": "<name>", "offset": 0}. Faces: box top, bottom, +X, -X, +Y, -Y; cylinder/cone top, bottom; extrude end (far cap), start (sketch side) and, for rectangle profiles, side faces +u, -u, +v, -v; a boolean uses its base object's faces; spheres have none. The face origin is the face center, the sketch u/v axes lie on the face (on side faces v points up), and extruding goes outward. A negative extrude distance goes inward: use it for pockets and holes on a face (e.g. distance -6 through a 4 mm plate from its top face), then cut. The sketch follows the object when it moves or changes size. An object with a sketch attached to its face cannot be deleted until that sketch is moved or deleted.
- Constrained shapes: add_polygon adds a closed polygon (points in sketch u/v coordinates; vertices "<id>.p0", "<id>.p1"…, edge k "<id>.ek" goes from pk to p(k+1), the last edge closes the loop). add_constraint makes the geometry exact and the app solves it, moving points as little as possible: fix [point]; coincident [point, point]; concentric [circle, circle]; horizontal / vertical [edge] or [point, point]; parallel / perpendicular / equal [edge, edge]; length [edge] + value; distance [point, point] + value; tangent [edge, circle]. Circle and rectangle centers are points "<id>.center"; circles are referenced by id. Contradicting constraints are rejected. For an L bracket or any non-rectangular plate: add_polygon with rough points, then fix one vertex, horizontal/vertical edges and lengths, then extrude the polygon id. Give constraints you may change later an explicit id (e.g. "len_base"); change a size later with set_constraint using that id (constraints without an id are named k1, k2, … in order).
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
