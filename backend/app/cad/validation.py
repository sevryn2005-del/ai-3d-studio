"""스키마로 표현할 수 없는 설계 원본의 의미 검증."""

from __future__ import annotations

from collections import Counter

from pydantic import BaseModel, ConfigDict, ValidationError

from app.cad.commands import (
    COMMAND_MODELS,
    OBJECT_MODELS,
    REQUIRED_DIMENSIONS,
    BooleanObject,
    BoxObject,
    ExtrudeObject,
    FacePlane,
    Limits,
    ModelDefinition,
    Sketch,
    max_edge_size,
    resolve_profile,
)
from app.cad.frames import dependency_cycle, faces_of


def _literal(model: type, field: str) -> str:
    return model.model_fields[field].annotation.__args__[0]  # Literal["..."]


# 판별 유니온 태그(오류 경로에 끼어드는 "box", "create_box" 등). 모델 정의에서 유도한다.
_UNION_TAGS: frozenset[str] = (
    frozenset(_literal(m, "kind") for m in OBJECT_MODELS)
    | frozenset(_literal(m, "type") for m in COMMAND_MODELS)
    | frozenset({"XY", "XZ", "YZ", "face", "rectangle", "circle"})  # 스케치 평면·요소 유니온 태그
)


class Issue(BaseModel):
    model_config = ConfigDict(frozen=True)

    path: str  # 예: "objects.0.params.height", 모델 전체는 ""
    message: str
    severity: str = "error"  # "error" | "warning"


# Pydantic 오류 유형 → 사용자용 한국어 메시지
_MESSAGES: dict[str, str] = {
    "missing": "필수 값이 없습니다",
    "extra_forbidden": "정의되지 않은 필드입니다",
    "float_type": "숫자여야 합니다",
    "string_type": "문자열이어야 합니다",
    "finite_number": "유한한 숫자여야 합니다",
    "greater_than_equal": "{ge} 이상이어야 합니다",
    "less_than_equal": "{le} 이하여야 합니다",
    "string_too_short": "{min_length}자 이상이어야 합니다",
    "string_too_long": "{max_length}자 이하여야 합니다",
    "string_pattern_mismatch": "형식이 올바르지 않습니다",
    "literal_error": "허용되지 않는 값입니다 (허용: {expected})",
    "union_tag_invalid": "알 수 없는 유형입니다: {tag}",
    "union_tag_not_found": "유형(type/kind) 필드가 필요합니다",
    "too_short": "항목이 {min_length}개 이상이어야 합니다",
    "too_long": "항목이 {max_length}개 이하여야 합니다",
    "tuple_type": "배열이어야 합니다",
    "model_type": "객체여야 합니다",
}


def issues_from_validation_error(err: ValidationError) -> list[Issue]:
    issues: list[Issue] = []
    for e in err.errors(include_url=False):
        # 판별 유니온의 태그(예: "box", "create_box")는 사용자에게 의미 없는 경로 조각이므로 제거
        path = ".".join(str(p) for p in e["loc"] if not _is_union_tag(p))
        template = _MESSAGES.get(e["type"])
        ctx = e.get("ctx") or {}
        if template:
            try:
                message = template.format(**ctx)
            except (KeyError, IndexError):
                message = e["msg"]
        else:
            # value_error 등: 우리 validator 가 던진 한국어 메시지 그대로 사용
            message = str(ctx.get("error", e["msg"])) if e["type"] == "value_error" else e["msg"]
        issues.append(Issue(path=path, message=message))
    return issues


def _is_union_tag(part: object) -> bool:
    return isinstance(part, str) and part in _UNION_TAGS


def check_model(model: ModelDefinition) -> list[Issue]:
    """스키마 검증을 통과한 모델의 의미 검사.

    frontend/src/cad/modelGraph.ts 의 validateGraph 와 같은 규칙:
    중복 ID, 없는 객체 참조, 자기 참조, 한 객체를 두 불리언이 공유, 순환, 중첩 깊이.
    """
    issues: list[Issue] = []
    counts = Counter(o.id for o in model.objects)
    for i, obj in enumerate(model.objects):
        if counts[obj.id] > 1:
            issues.append(Issue(path=f"objects.{i}.id", message=f"중복된 객체 ID입니다: {obj.id}"))

    for i, obj in enumerate(model.objects):
        if isinstance(obj, BoxObject) and obj.edgeFeature:
            limit = max_edge_size(obj.params, obj.edgeFeature.edges)
            if obj.edgeFeature.size >= limit:
                issues.append(Issue(path=f"objects.{i}.edgeFeature.size",
                                    message=f"{obj.id}: 모서리 크기 {obj.edgeFeature.size:g}mm 가 너무 큽니다 ({limit:g}mm 보다 작아야 합니다)"))

    object_ids = {o.id for o in model.objects}
    seen_sketches: set[str] = set()
    for i, sk in enumerate(model.sketches):
        if sk.id in seen_sketches or sk.id in object_ids:
            issues.append(Issue(path=f"sketches.{i}.id", message=f"중복된 ID입니다: {sk.id}"))
        seen_sketches.add(sk.id)
        issues.extend(Issue(path=f"sketches.{i}", message=m) for m in sketch_errors(sk))
    sketches = {sk.id: sk for sk in model.sketches}
    for i, obj in enumerate(model.objects):
        if isinstance(obj, ExtrudeObject):
            sk = sketches.get(obj.extrude.sketch)
            if sk is None:
                issues.append(Issue(path=f"objects.{i}.extrude.sketch", message=f"{obj.id}: 존재하지 않는 스케치를 참조합니다: {obj.extrude.sketch}"))
            elif resolve_profile(sk, obj.extrude.profile) is None:
                issues.append(Issue(path=f"objects.{i}.extrude.profile",
                                    message=f"{obj.id}: 스케치 {sk.id} 에 사용할 수 있는 프로파일 {obj.extrude.profile} 이(가) 없습니다"))

    # 면 평면: 붙은 객체·면 이름·순환 (프론트엔드 modelGraph.validateGraph 와 같은 규칙)
    by_id = {o.id: o for o in model.objects}
    for i, sk in enumerate(model.sketches):
        if not isinstance(sk.plane, FacePlane):
            continue
        anchor = by_id.get(sk.plane.object)
        if anchor is None:
            issues.append(Issue(path=f"sketches.{i}.plane.object", message=f"{sk.id}: 존재하지 않는 객체의 면에 붙어 있습니다: {sk.plane.object}"))
        elif sk.plane.face not in (faces := faces_of(model, anchor)):
            issues.append(Issue(path=f"sketches.{i}.plane.face",
                                message=f"{sk.id}: {anchor.name} 에는 '{sk.plane.face}' 면이 없습니다 (있는 면: {', '.join(faces) or '없음'})"))
    if cycle := dependency_cycle(model):
        issues.append(Issue(path="", message=cycle))

    index = {o.id: o for o in model.objects}
    parent_of: dict[str, str] = {}
    for i, obj in enumerate(model.objects):
        if not isinstance(obj, BooleanObject):
            continue
        ids = obj.child_ids
        path = f"objects.{i}.boolean"
        if len(set(ids)) != len(ids):
            issues.append(Issue(path=path, message=f"{obj.id}: 같은 객체가 두 번 이상 참조되었습니다"))
        for c in ids:
            if c == obj.id:
                issues.append(Issue(path=path, message=f"{obj.id}: 자기 자신을 참조할 수 없습니다"))
            elif c not in index:
                issues.append(Issue(path=path, message=f"{obj.id}: 존재하지 않는 객체를 참조합니다: {c}"))
            elif c in parent_of and parent_of[c] != obj.id:
                issues.append(Issue(path=path, message=f"{c}: 두 개 이상의 불리언에서 사용되었습니다"))
            else:
                parent_of[c] = obj.id

    for oid in index:
        seen: set[str] = set()
        cur: str | None = oid
        while cur is not None:
            if cur in seen:
                issues.append(Issue(path="objects", message=f"순환 참조가 있습니다: {oid}"))
                break
            seen.add(cur)
            cur = parent_of.get(cur)

    if not issues:
        for i, obj in enumerate(model.objects):
            if depth_of(obj.id, index) > Limits.MAX_BOOLEAN_DEPTH:
                issues.append(
                    Issue(
                        path=f"objects.{i}",
                        message=f"{obj.id}: 불리언 중첩은 최대 {Limits.MAX_BOOLEAN_DEPTH}단계까지 가능합니다",
                    )
                )
    return issues


def sketch_errors(sk: Sketch) -> list[str]:
    """frontend/src/cad/sketch.ts 의 sketchErrors 와 같은 규칙."""
    errors: list[str] = []
    ids: set[str] = set()
    for e in sk.entities:
        if e.id in ids:
            errors.append(f"{sk.id}: 요소 ID 가 중복되었습니다: {e.id}")
        ids.add(e.id)
    types = {e.id: e.type for e in sk.entities}
    seen: set[str] = set()
    for d in sk.dimensions:
        if d.entity not in types:
            errors.append(f"{sk.id}: 치수 {d.id} 가 없는 요소를 가리킵니다: {d.entity}")
        elif d.kind not in REQUIRED_DIMENSIONS[types[d.entity]]:
            errors.append(f"{sk.id}: {types[d.entity]} 에는 {d.kind} 치수가 없습니다")
        if d.id != f"{d.entity}.{d.kind}":
            errors.append(f"{sk.id}: 치수 ID 는 {d.entity}.{d.kind} 이어야 합니다 ({d.id})")
        if d.id in seen:
            errors.append(f"{sk.id}: 치수가 중복되었습니다: {d.id}")
        seen.add(d.id)
    for e in sk.entities:
        for k in REQUIRED_DIMENSIONS[e.type]:
            if not any(d.entity == e.id and d.kind == k for d in sk.dimensions):
                errors.append(f"{sk.id}: {e.id} 의 {k} 치수가 없습니다")
    return errors


def depth_of(oid: str, index: dict) -> int:
    obj = index.get(oid)
    if not isinstance(obj, BooleanObject):
        return 0
    return 1 + max(depth_of(c, index) for c in obj.child_ids)


def top_level_ids(model: ModelDefinition) -> list[str]:
    children = {c for o in model.objects if isinstance(o, BooleanObject) for c in o.child_ids}
    return [o.id for o in model.objects if o.id not in children]
