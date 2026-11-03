"""내보내기 API (STL / 3MF / STEP / GLB). 모두 로컬 CAD 엔진에서 생성한다.
검증·계산 실패는 422 + {ok: false, issues} (파일 대신 JSON)."""

from __future__ import annotations

from typing import Annotated, Any, Literal

from fastapi import APIRouter, Body, Depends
from fastapi.responses import JSONResponse, Response
from pydantic import ValidationError

from app.api.deps import get_cad_pool
from app.cad.commands import ModelDefinition
from app.cad.exporter import FORMATS
from app.cad.validation import Issue, check_model, issues_from_validation_error
from app.cad.worker_pool import CadEngineError, WorkerPool

router = APIRouter(tags=["export"])

EXPORT_TIMEOUT_S = 60.0  # 고정밀 테셀레이션은 화면용보다 오래 걸릴 수 있다
ExportFormat = Literal["stl", "3mf", "step", "glb"]


def _issues_response(issues: list[Issue]) -> JSONResponse:
    return JSONResponse(status_code=422, content={"ok": False, "issues": [i.model_dump() for i in issues]})


@router.post(
    "/export/{fmt}",
    response_class=Response,
    responses={200: {"content": {f["media_type"]: {} for f in FORMATS.values()}}, 422: {"description": "검증 또는 형상 계산 실패"}},
)
def export_file(
    fmt: ExportFormat,
    pool: Annotated[WorkerPool, Depends(get_cad_pool)],
    payload: Any = Body(...),
) -> Response:
    try:
        model = ModelDefinition.model_validate(payload)
    except ValidationError as e:
        return _issues_response(issues_from_validation_error(e))
    issues = check_model(model)
    if issues:
        return _issues_response(issues)
    try:
        data = pool.run("export", {"model": model.model_dump(mode="json"), "format": fmt}, timeout=EXPORT_TIMEOUT_S)
    except CadEngineError as e:
        return _issues_response([Issue(path="", message=str(e))])
    return Response(
        content=data,
        media_type=FORMATS[fmt]["media_type"],
        headers={"Content-Disposition": f'attachment; filename="model.{fmt}"'},
    )
