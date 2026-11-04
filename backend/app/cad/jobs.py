"""CAD 워커 프로세스에서 실행되는 작업 레지스트리.

이 모듈은 워커 프로세스 안에서만 import 된다 (API 프로세스는 CadQuery 를 로드하지 않음).
여기 JOBS 에 등록된 함수만 실행 가능하다.
"""

from __future__ import annotations

import hashlib
import json
import time
from collections import OrderedDict
from typing import Any, Callable

from app.cad.commands import ModelDefinition, sketch_refs
from app.cad.exporter import FORMATS, NamedShape, export_shapes
from app.cad.primitives import GeometryError, apply_transform, build_solid
from app.cad.validation import active_top_level_ids
from app.cad.mesh import encode_mesh, tessellate

USER_ERRORS = (GeometryError,)

# 객체별 표시 메시 캐시 (워커 프로세스마다). 키 = 그 객체 하위 트리 + 쓰는 스케치 (+ 면 위 스케치면 모델 전체).
# 무거운 형상(나사산 등)이 있어도 다른 곳을 고칠 때 다시 계산하지 않는다 — 프론트엔드 형상 키 캐시와 같은 원리.
_MESH_CACHE: OrderedDict[str, dict[str, Any]] = OrderedDict()
_MESH_CACHE_SIZE = 64


def _cache_key(model: ModelDefinition, oid: str) -> str:
    index = {o.id: o for o in model.objects}
    ids, stack = [], [oid]
    while stack:
        cur = stack.pop()
        if cur in index and cur not in ids:
            ids.append(cur)
            stack.extend(index[cur].child_ids)
    refs = {r.sketch for i in ids for r in sketch_refs(index[i])}
    sketches = [s for s in model.sketches if s.id in refs]
    face = any(s.plane.type == "face" for s in sketches)
    parts = [index[i].model_dump(mode="json") for i in ids] + [s.model_dump(mode="json") for s in sketches]
    if face:  # 면 위 스케치는 붙은 객체의 형상·위치에 따라 바뀐다 → 모델 전체
        parts.append(model.model_dump(mode="json"))
    root = parts[0] if parts else {}
    if isinstance(root, dict):
        root = {**root, "transform": None}  # 최상위 객체 자신의 위치는 로컬 메시와 무관
        parts[0] = root
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


def warmup() -> str:
    import cadquery

    # 첫 연산의 지연(지연 로딩되는 OCCT 모듈)을 미리 흡수
    cadquery.Solid.makeBox(1, 1, 1).tessellate(0.1)
    return f"cadquery {cadquery.__version__}"


def evaluate(payload: dict[str, Any]) -> dict[str, Any]:
    """설계 원본 → 최상위 객체별 RenderMesh (객체 로컬 좌표계). 불리언의 자식은 부모 메시에 포함된다."""
    started = time.perf_counter()
    model = ModelDefinition.model_validate(payload)
    index = {o.id: o for o in model.objects}
    meshes = []
    for oid in active_top_level_ids(model):
        obj = index[oid]
        key = _cache_key(model, oid)
        if key in _MESH_CACHE:
            _MESH_CACHE.move_to_end(key)
            meshes.append({"objectId": obj.id, **_MESH_CACHE[key]})
            continue
        try:
            solid = build_solid(obj, index, {sk.id: sk for sk in model.sketches})
        except GeometryError:
            raise
        except Exception as e:  # OCCT 예외 → 사용자 메시지
            raise GeometryError(f"'{obj.name}' 형상을 만들 수 없습니다") from e
        # 가져온 메시는 삼각형 면을 꿰맨 형상이라 OCCT 검사가 엄격하게 실패할 수 있다 (불리언·출력은 정상) → 부피로만 확인
        if obj.kind == "mesh" and solid.Volume() > 0:
            pass
        elif not solid.isValid():
            raise GeometryError(f"'{obj.name}' 형상이 올바르지 않습니다")
        v, t = tessellate(solid)
        encoded = encode_mesh(v, t)
        _MESH_CACHE[key] = encoded
        if len(_MESH_CACHE) > _MESH_CACHE_SIZE:
            _MESH_CACHE.popitem(last=False)
        meshes.append({"objectId": obj.id, **encoded})
    return {"meshes": meshes, "computeMs": round((time.perf_counter() - started) * 1000, 1)}


def export_file(payload: dict[str, Any]) -> bytes:
    """{model, format} → 모든 최상위 객체를 월드 좌표로 배치한 파일 (stl / 3mf / step / glb)."""
    fmt = payload["format"]
    if fmt not in FORMATS:
        raise GeometryError(f"지원하지 않는 형식입니다: {fmt}")
    model = ModelDefinition.model_validate(payload["model"])
    index = {o.id: o for o in model.objects}
    objects = []
    for oid in active_top_level_ids(model):
        obj = index[oid]
        try:
            objects.append(NamedShape(obj.name, apply_transform(build_solid(obj, index, {sk.id: sk for sk in model.sketches}), obj.transform), obj.color))
        except GeometryError:
            raise
        except Exception as e:
            raise GeometryError(f"'{obj.name}' 형상을 만들 수 없습니다") from e
    if not objects:
        raise GeometryError("내보낼 객체가 없습니다")
    return export_shapes(fmt, objects)


JOBS: dict[str, Callable[[Any], Any]] = {
    "evaluate": evaluate,
    "export": export_file,
}
