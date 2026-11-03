"""설계 검증 API.

요청 본문은 Pydantic 자동 검증 대신 직접 검증한다.
→ 잘못된 입력에도 422 대신 200 + {ok: false, issues} 형식으로 일관되게 응답하여
  프론트엔드와 AI 파이프라인이 오류를 같은 방식으로 처리할 수 있게 한다.
"""

from __future__ import annotations

from typing import Annotated, Any

from fastapi import APIRouter, Body, Depends
from pydantic import BaseModel, ValidationError

from app.api.deps import get_cad_pool
from app.cad.commands import CadCommandAdapter, ModelDefinition
from app.cad.validation import Issue, check_model, issues_from_validation_error
from app.cad.worker_pool import CadEngineError, WorkerPool

router = APIRouter(tags=["modeling"])


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
        result = pool.run("evaluate", model.model_dump(mode="json"))
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
