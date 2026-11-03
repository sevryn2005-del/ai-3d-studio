from typing import Annotated

from fastapi import APIRouter, Depends
from pydantic import BaseModel

from app import __version__
from app.api.deps import get_cad_pool
from app.cad.worker_pool import WorkerPool

router = APIRouter(tags=["system"])


class HealthResponse(BaseModel):
    status: str
    version: str
    cadEngine: str  # 예: "cadquery 2.8.0", 워커 준비 전에는 "starting"


@router.get("/health", response_model=HealthResponse)
def health(pool: Annotated[WorkerPool, Depends(get_cad_pool)]) -> HealthResponse:
    return HealthResponse(status="ok", version=__version__, cadEngine=pool.engine_info or "starting")
