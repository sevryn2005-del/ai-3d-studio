"""AI 가 만든 명령 목록의 실행 전 검증 (스키마 + 현재 모델 기준 참조 검사).

실제 실행은 프론트엔드 실행기가 한 단계(실행 취소 1회)로 원자적으로 한다. 여기서는 AI 에게 고칠 기회를
주기 위해 흔한 오류를 미리 잡는다: 없는 객체, 도형에 없는 파라미터, 불리언에 이미 포함된 피연산자,
중복 ID. 오류 메시지는 AI 가 읽고 고칠 수 있도록 구체적으로 쓴다.
"""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.cad.commands import (
    BooleanObject,
    CadCommandAdapter,
    ModelDefinition,
    PARAMS_MODELS,
)
from app.cad.validation import issues_from_validation_error

_CREATE_KIND = {"create_box": "box", "create_cylinder": "cylinder", "create_sphere": "sphere", "create_cone": "cone"}


def validate_commands(raw: Any, model: ModelDefinition) -> tuple[list[dict[str, Any]], list[str]]:
    """(정규화된 명령 목록, 오류 목록). 오류가 하나라도 있으면 명령은 적용하면 안 된다."""
    if not isinstance(raw, list) or not raw:
        return [], ["commands must be a non-empty array"]

    commands: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, item in enumerate(raw):
        try:
            cmd = CadCommandAdapter.validate_python(item)
        except ValidationError as e:
            for issue in issues_from_validation_error(e):
                where = f".{issue.path}" if issue.path else ""
                errors.append(f"commands[{i}]{where}: {issue.message}")
            continue
        commands.append(cmd.model_dump(mode="json", exclude_unset=True))
    if errors:
        return [], errors

    # 현재 모델 상태를 따라가며 참조 검사
    kinds: dict[str, str] = {o.id: o.kind for o in model.objects}
    parent: dict[str, str] = {}
    for o in model.objects:
        if isinstance(o, BooleanObject):
            for c in o.child_ids:
                parent[c] = o.id

    def exists(i: int, oid: str, role: str) -> bool:
        if oid in kinds:
            return True
        errors.append(f"commands[{i}].{role}: object '{oid}' does not exist (existing: {', '.join(sorted(kinds)) or 'none'})")
        return False

    for i, c in enumerate(commands):
        t = c["type"]
        if t in _CREATE_KIND:
            oid = c.get("id")
            if oid is None:
                continue  # 이름 자동 생성: 이후 참조할 수 없음
            if oid in kinds:
                errors.append(f"commands[{i}].id: id '{oid}' is already used")
            kinds[oid] = _CREATE_KIND[t]
        elif t in ("cut", "union", "intersect"):
            ids = [c["base"], *c["tools"]]
            if len(set(ids)) != len(ids):
                errors.append(f"commands[{i}]: the same object appears twice in base/tools")
            for role, oid in [("base", c["base"]), *[(f"tools[{k}]", x) for k, x in enumerate(c["tools"])]]:
                if exists(i, oid, role) and oid in parent:
                    errors.append(f"commands[{i}].{role}: '{oid}' is already inside boolean '{parent[oid]}'; use '{parent[oid]}' instead")
            new_id = c.get("id")
            if new_id is not None:
                if new_id in kinds:
                    errors.append(f"commands[{i}].id: id '{new_id}' is already used")
                kinds[new_id] = "boolean"
                for oid in ids:
                    parent[oid] = new_id
        elif t == "set_params":
            if exists(i, c["target"], "target"):
                kind = kinds[c["target"]]
                allowed = set(PARAMS_MODELS[kind].model_fields) if kind in PARAMS_MODELS else set()
                bad = sorted(set(c["params"]) - allowed)
                if bad:
                    hint = ", ".join(sorted(allowed)) or "none (edit its child objects instead)"
                    errors.append(f"commands[{i}].params: {kind} '{c['target']}' has no parameter {', '.join(bad)} (allowed: {hint})")
        elif t == "delete_object":
            if exists(i, c["target"], "target"):
                if c["target"] in parent:
                    errors.append(f"commands[{i}].target: '{c['target']}' is inside boolean '{parent[c['target']]}' and cannot be deleted alone")
                kinds.pop(c["target"], None)
        elif t == "duplicate_object":
            if exists(i, c["target"], "target") and c.get("newId"):
                kinds[c["newId"]] = kinds[c["target"]]
        else:  # translate, set_transform, rename_object
            exists(i, c["target"], "target")

    return (commands if not errors else []), errors
