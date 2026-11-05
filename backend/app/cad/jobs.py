"""CAD 워커 프로세스에서 실행되는 작업 레지스트리.

이 모듈은 워커 프로세스 안에서만 import 된다 (API 프로세스는 CadQuery 를 로드하지 않음).
여기 JOBS 에 등록된 함수만 실행 가능하다.
"""

from __future__ import annotations

import time
from typing import Any, Callable

from app.cad.commands import ModelDefinition
from app.cad.exporter import FORMATS, NamedShape, export_shapes
from app.cad.primitives import GeometryError, apply_transform, build_solid
from app.cad.validation import active_top_level_ids
from app.cad.mesh import encode_mesh, tessellate

USER_ERRORS = (GeometryError,)

def warmup() -> str:
    import cadquery

    # 첫 연산의 지연(지연 로딩되는 OCCT 모듈)을 미리 흡수
    cadquery.Solid.makeBox(1, 1, 1).tessellate(0.1)
    return f"cadquery {cadquery.__version__}"


def evaluate(payload: dict[str, Any]) -> dict[str, Any]:
    """설계 원본 → 최상위 객체별 RenderMesh (객체 로컬 좌표계). 불리언의 자식은 부모 메시에 포함된다."""
    model = ModelDefinition.model_validate(payload)
    return _evaluate(model, active_top_level_ids(model))


def evaluate_objects(payload: dict[str, Any]) -> dict[str, Any]:
    """{model, ids} → 그 최상위 객체들만 계산 (API 의 공유 메시 캐시에 없는 것만 보낸다)"""
    model = ModelDefinition.model_validate(payload["model"])
    return _evaluate(model, list(payload["ids"]))


def _evaluate(model: ModelDefinition, ids: list[str]) -> dict[str, Any]:
    started = time.perf_counter()
    index = {o.id: o for o in model.objects}
    meshes = []
    for oid in ids:
        obj = index[oid]
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
        meshes.append({"objectId": obj.id, **encode_mesh(v, t)})
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


# 간섭: 이보다 작은 겹침 부피(mm³)는 맞닿음(수치 오차)으로 본다 — 브라우저 엔진 worker.ts 와 같음
INTERFERENCE_MIN_VOLUME = 1e-3


def interference(payload: dict[str, Any]) -> list[dict[str, Any]]:
    """{model} → 서로 파고드는 최상위 객체 쌍과 겹친 부피 (솔리드웍스 간섭 검사). 바운딩 박스로 먼저 거른다."""
    model = ModelDefinition.model_validate(payload["model"])
    index = {o.id: o for o in model.objects}
    sketches = {sk.id: sk for sk in model.sketches}
    solids = []
    for oid in active_top_level_ids(model):
        obj = index[oid]
        try:
            solids.append((obj, apply_transform(build_solid(obj, index, sketches), obj.transform)))
        except GeometryError:
            raise
        except Exception as e:
            raise GeometryError(f"'{obj.name}' 형상을 만들 수 없습니다") from e
    boxes = [s.BoundingBox() for _, s in solids]
    out = []
    for i in range(len(solids)):
        for j in range(i + 1, len(solids)):
            a, b = boxes[i], boxes[j]
            if a.xmax <= b.xmin or b.xmax <= a.xmin or a.ymax <= b.ymin or b.ymax <= a.ymin or a.zmax <= b.zmin or b.zmax <= a.zmin:
                continue
            vol = solids[i][1].intersect(solids[j][1]).Volume()
            if vol > INTERFERENCE_MIN_VOLUME:
                out.append({"a": solids[i][0].id, "b": solids[j][0].id, "volume": round(vol, 4)})
    return out


JOBS: dict[str, Callable[[Any], Any]] = {
    "interference": interference,
    "evaluate": evaluate,
    "evaluate_objects": evaluate_objects,
    "export": export_file,
}
