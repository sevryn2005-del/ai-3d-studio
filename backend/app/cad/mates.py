"""조립 메이트 검사 (형식 v11) — frontend/src/cad/mates.ts 와 같은 참조 규칙·같은 잔차.

풀이는 프론트엔드 실행기가 한다 (저장된 변환 = 푼 결과). 서버는 저장된 모델이 메이트를 만족하는지만 검사한다
(스케치 구속과 같은 원칙: 해석기가 푼 결과만 저장된다).
"""

from __future__ import annotations

import math

import numpy as np

from app.cad.commands import CadObject, Mate, ModelDefinition
from app.cad.frames import axis_local, face_local_matrix, faces_of, transform_matrix

MATE_TOLERANCE = 1e-4  # mates.ts MATE_TOLERANCE 와 같음
LABEL = {"coincident": "일치", "distance": "거리", "parallel": "평행", "perpendicular": "직각", "angle": "각도",
         "concentric": "동심", "fix": "고정"}


def _split(ref: str) -> tuple[str, str]:
    oid, _, part = ref.partition(".")
    return oid, part


def _local_frame(model: ModelDefinition, obj: CadObject, part: str):
    if part == "axis":
        return axis_local(model, obj)
    if part not in faces_of(model, obj):
        return None
    m = face_local_matrix(model, obj, part)
    return (m[:3, 3].copy(), m[:3, 2].copy()) if m is not None else None


def _top_level_ids(model: ModelDefinition) -> set[str]:
    children = {c for o in model.objects for c in o.child_ids}
    return {o.id for o in model.objects if o.id not in children}


def mate_error(model: ModelDefinition, m: Mate) -> str | None:
    tops = _top_level_ids(model)
    need = 1 if m.type == "fix" else 2
    if len(m.refs) != need:
        return f"{LABEL[m.type]} 메이트는 참조가 {need}개입니다"
    for ref in m.refs:
        oid, part = _split(ref)
        obj = next((o for o in model.objects if o.id == oid), None)
        if obj is None:
            return f"존재하지 않는 객체입니다: {oid}"
        if oid not in tops:
            return f"'{obj.name}'은(는) 다른 객체에 포함되어 있습니다. 메이트는 최상위 객체(부품)끼리 겁니다"
        if m.type == "fix":
            if part:
                return "고정 메이트는 객체 ID 만 참조합니다"
            continue
        if not part:
            return f"{ref}: 면 또는 축을 지정하세요"
        if _local_frame(model, obj, part) is None:
            return f"'{obj.name}'에는 {'축' if part == 'axis' else repr(part) + ' 면'}이 없습니다"
        if m.type in ("coincident", "distance") and part == "axis":
            return f"{LABEL[m.type]} 메이트는 면끼리 겁니다 (축은 동심)"
        if m.type == "concentric" and part != "axis":
            return "동심 메이트는 축끼리 겁니다"
    if m.type != "fix" and _split(m.refs[0])[0] == _split(m.refs[1])[0]:
        return "같은 객체끼리는 메이트를 걸 수 없습니다"
    if m.type in ("distance", "angle") and m.value is None:
        return f"{LABEL[m.type]} 메이트에는 값이 필요합니다"
    return None


def residuals(model: ModelDefinition, m: Mate) -> list[float]:
    if m.type == "fix":
        return []
    frames = []
    for ref in m.refs:
        oid, part = _split(ref)
        obj = next(o for o in model.objects if o.id == oid)
        o, n = _local_frame(model, obj, part)
        w = transform_matrix(obj.transform)
        frames.append(((w @ np.append(o, 1.0))[:3], w[:3, :3] @ n))
    (oa, na), (ob, nb) = frames
    d = ob - oa
    if m.type in ("coincident", "distance"):
        nn = na - nb if m.flip else na + nb
        target = (m.value or 0.0) if m.type == "distance" else 0.0
        return [*nn, float(d @ na) - target]
    if m.type == "parallel":
        return list(np.cross(na, nb))
    if m.type == "perpendicular":
        return [float(na @ nb)]
    if m.type == "angle":
        return [float(na @ nb) - math.cos(math.radians(m.value or 0.0))]
    return [*np.cross(na, nb), *np.cross(d, na)]  # concentric


def mate_errors(model: ModelDefinition) -> list[tuple[str, str]]:
    """(메이트 id, 문제) — 형식 오류와 저장된 변환이 메이트를 만족하지 않는 경우"""
    out: list[tuple[str, str]] = []
    seen: set[str] = set()
    for m in model.mates or []:
        if m.id in seen:
            out.append((m.id, f"메이트 ID 가 중복되었습니다: {m.id}"))
        seen.add(m.id)
        if err := mate_error(model, m):
            out.append((m.id, err))
            continue
        worst = max((abs(v) for v in residuals(model, m)), default=0.0)
        if worst > MATE_TOLERANCE:
            out.append((m.id, f"메이트 {m.id} 을(를) 만족하지 않습니다 (오차 {worst:.1e})"))
    return out
