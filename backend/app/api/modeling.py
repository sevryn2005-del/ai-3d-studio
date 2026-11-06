"""설계 검증 API.

요청 본문은 Pydantic 자동 검증 대신 직접 검증한다.
→ 잘못된 입력에도 422 대신 200 + {ok: false, issues} 형식으로 일관되게 응답하여
  프론트엔드와 AI 파이프라인이 오류를 같은 방식으로 처리할 수 있게 한다.
"""

from __future__ import annotations

import math
import time
from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel, ValidationError

from app.api.deps import get_cad_pool
from app.cad.commands import CadCommandAdapter, DrawingSection, ModelDefinition
from app.cad.mesh_cache import MeshCache, cache_key
from app.cad.validation import (
    Issue,
    active_top_level_ids,
    check_model,
    issues_from_validation_error,
)
from app.cad.worker_pool import CadEngineError, WorkerPool

router = APIRouter(tags=["modeling"])

def mesh_cache(pool: WorkerPool) -> MeshCache:
    """워커 풀(= CAD 엔진 하나)마다 하나: 그 풀의 모든 워커가 공유하는 객체별 메시 캐시 (app/cad/mesh_cache.py)"""
    cache = getattr(pool, "mesh_cache", None)
    if cache is None:
        cache = MeshCache()
        pool.mesh_cache = cache  # type: ignore[attr-defined]
    return cache


def _evaluate_cached(pool: WorkerPool, model: ModelDefinition) -> dict[str, Any]:
    """캐시에 없는 최상위 객체만 워커에서 계산하고, 결과를 모델 순서대로 합친다"""
    started = time.perf_counter()
    MESH_CACHE = mesh_cache(pool)
    ids = active_top_level_ids(model)
    keys = {oid: cache_key(model, oid) for oid in ids}
    mine, waits = MESH_CACHE.claim(list(dict.fromkeys(keys.values())))
    dumped = model.model_dump(mode="json") if mine else None
    try:
        # 객체마다 작업 하나: 작업 시간 제한이 객체별로 걸리고, 끝나는 즉시 기다리던 요청이 깨어난다
        for key in mine:
            oid = next(o for o in ids if keys[o] == key)
            result = pool.run("evaluate_objects", {"model": dumped, "ids": [oid]})
            for m in result["meshes"]:
                MESH_CACHE.put(key, {k: v for k, v in m.items() if k != "objectId"})
            MESH_CACHE.release([key])
    finally:
        MESH_CACHE.release(mine)
    for ev in waits:
        ev.wait(pool.job_timeout + 5)
    # 다른 요청이 실패해 캐시에 없으면 여기서 직접 계산 (오류 메시지를 그대로 받도록)
    left = [oid for oid in ids if MESH_CACHE.get(keys[oid]) is None]
    if left:
        result = pool.run("evaluate_objects", {"model": model.model_dump(mode="json"), "ids": left})
        for m in result["meshes"]:
            MESH_CACHE.put(keys[m["objectId"]], {k: v for k, v in m.items() if k != "objectId"})
    meshes = []
    for oid in ids:
        cached = MESH_CACHE.get(keys[oid])
        if cached is not None:
            meshes.append({"objectId": oid, **cached})
    return {"meshes": meshes, "computeMs": round((time.perf_counter() - started) * 1000, 1)}


class ValidationResponse(BaseModel):
    ok: bool
    issues: list[Issue]


class CommandValidationResponse(ValidationResponse):
    command: dict[str, Any] | None = None  # 정규화된 명령 (예: 이름 앞뒤 공백 제거)


class RenderMesh(BaseModel):
    objectId: str
    positions: str  # base64, little-endian Float32 × 3 × vertexCount (객체 로컬 좌표, mm)
    indices: str  # base64, little-endian Uint32 × 3 × triangleCount
    vertexCount: int
    triangleCount: int


class ModelEvaluationResponse(ValidationResponse):
    objectCount: int = 0
    meshes: list[RenderMesh] = []
    computeMs: float | None = None


@router.post("/commands/validate", response_model=CommandValidationResponse)
def validate_command(payload: Any = Body(...)) -> CommandValidationResponse:
    """CAD 명령 하나의 스키마 검증. 객체 존재 여부는 모델과 함께 실행할 때 검사한다."""
    try:
        cmd = CadCommandAdapter.validate_python(payload)
    except ValidationError as e:
        return CommandValidationResponse(ok=False, issues=issues_from_validation_error(e))
    return CommandValidationResponse(
        ok=True, issues=[], command=cmd.model_dump(mode="json", exclude_unset=True)
    )


@router.post("/model/evaluate", response_model=ModelEvaluationResponse)
def evaluate_model(
    pool: Annotated[WorkerPool, Depends(get_cad_pool)],
    payload: Any = Body(...),
) -> ModelEvaluationResponse:
    """설계 원본 검증 → CadQuery 형상 계산 → 객체별 RenderMesh.

    동기 함수이므로 FastAPI 스레드 풀에서 실행되며, 실제 계산은 격리 워커에서 수행된다.
    """
    try:
        model = ModelDefinition.model_validate(payload)
    except ValidationError as e:
        return ModelEvaluationResponse(ok=False, issues=issues_from_validation_error(e))
    issues = check_model(model)
    if any(i.severity == "error" for i in issues):
        return ModelEvaluationResponse(ok=False, issues=issues, objectCount=len(model.objects))

    try:
        result = _evaluate_cached(pool, model)
    except CadEngineError as e:
        return ModelEvaluationResponse(
            ok=False, issues=[*issues, Issue(path="", message=str(e))], objectCount=len(model.objects)
        )
    return ModelEvaluationResponse(
        ok=True,
        issues=issues,
        objectCount=len(model.objects),
        meshes=result["meshes"],
        computeMs=result["computeMs"],
    )


INTERFERENCE_TIMEOUT_S = 60.0


@router.post("/model/interference")
def model_interference(
    pool: Annotated[WorkerPool, Depends(get_cad_pool)],
    payload: Any = Body(...),
) -> dict[str, Any]:
    """간섭 검사 (조립품, 형식 v11): 서로 파고드는 최상위 객체 쌍과 겹친 부피(mm³)."""
    try:
        model = ModelDefinition.model_validate(payload)
    except ValidationError as e:
        return {"ok": False, "issues": [i.model_dump() for i in issues_from_validation_error(e)], "pairs": []}
    issues = [i for i in check_model(model) if i.severity == "error"]
    if issues:
        return {"ok": False, "issues": [i.model_dump() for i in issues], "pairs": []}
    try:
        pairs = pool.run("interference", {"model": model.model_dump(mode="json")}, timeout=INTERFERENCE_TIMEOUT_S)
    except CadEngineError as e:
        return {"ok": False, "issues": [Issue(path="", message=str(e)).model_dump()], "pairs": []}
    return {"ok": True, "issues": [], "pairs": pairs}


@router.post("/model/topology")
def model_topology(
    pool: Annotated[WorkerPool, Depends(get_cad_pool)],
    payload: Any = Body(...),
) -> dict[str, Any]:
    """화면 선택용 면·모서리 (형식 v12): {model, id} → {ok, faces, edges}"""
    try:
        model = ModelDefinition.model_validate(payload.get("model") if isinstance(payload, dict) else None)
    except ValidationError as e:
        return {"ok": False, "issues": [i.model_dump() for i in issues_from_validation_error(e)]}
    issues = [i for i in check_model(model) if i.severity == "error"]
    if issues:
        return {"ok": False, "issues": [i.model_dump() for i in issues]}
    try:
        topo = pool.run("topology", {"model": model.model_dump(mode="json"), "id": str(payload.get("id", ""))}, timeout=INTERFERENCE_TIMEOUT_S)
    except CadEngineError as e:
        return {"ok": False, "issues": [Issue(path="", message=str(e)).model_dump()]}
    return {"ok": True, "issues": [], **topo}


DRAWING_VIEWS = ("front", "top", "right", "iso")


def _valid_aux(aux: Any) -> bool:
    """보조 투상도 방향: 최대 2개, 각각 {toward, right} 유한한 3성분 단위 벡터이고 서로 수직"""
    if not isinstance(aux, list) or len(aux) > 2:
        return False
    for a in aux:
        if not isinstance(a, dict) or set(a) != {"toward", "right"}:
            return False
        vs = [a["toward"], a["right"]]
        if any(not isinstance(v, list) or len(v) != 3 or any(not isinstance(x, (int, float)) or isinstance(x, bool) or not math.isfinite(x) for x in v) for v in vs):
            return False
        if any(abs(math.hypot(*v) - 1) > 1e-6 for v in vs) or abs(sum(p * q for p, q in zip(*vs))) > 1e-6:
            return False
    return True


@router.post("/model/drawing")
def model_drawing(
    pool: Annotated[WorkerPool, Depends(get_cad_pool)],
    payload: Any = Body(...),
) -> dict[str, Any]:
    """도면 투상 (숨은선 제거): {model, views, section?} → {ok, views: [{name, visible, hidden, circles, bounds}]}"""
    try:
        model = ModelDefinition.model_validate(payload.get("model") if isinstance(payload, dict) else None)
    except ValidationError as e:
        return {"ok": False, "issues": [i.model_dump() for i in issues_from_validation_error(e)], "views": []}
    views = payload.get("views") or list(DRAWING_VIEWS)
    if not isinstance(views, list) or any(v not in DRAWING_VIEWS for v in views) or len(views) > len(DRAWING_VIEWS):
        return {"ok": False, "issues": [Issue(path="views", message="보기는 front·top·right·iso 중에서 고릅니다").model_dump()], "views": []}
    aux = payload.get("aux") or []
    if not _valid_aux(aux):
        return {"ok": False, "issues": [Issue(path="aux", message="보조 투상도 방향은 서로 수직인 단위 벡터 toward·right 두 개까지입니다").model_dump()], "views": []}
    section = payload.get("section")
    if section is not None:
        try:
            section = DrawingSection.model_validate(section).model_dump(mode="json")
        except ValidationError as e:
            return {"ok": False, "issues": [i.model_dump() for i in issues_from_validation_error(e)], "views": []}
    issues = [i for i in check_model(model) if i.severity == "error"]
    if issues:
        return {"ok": False, "issues": [i.model_dump() for i in issues], "views": []}
    try:
        job = {"model": model.model_dump(mode="json"), "views": views, **({"section": section} if section else {}), **({"aux": aux} if aux else {})}
        out = pool.run("drawing", job, timeout=INTERFERENCE_TIMEOUT_S)
    except CadEngineError as e:
        return {"ok": False, "issues": [Issue(path="", message=str(e)).model_dump()], "views": []}
    return {"ok": True, "issues": [], "views": out}
