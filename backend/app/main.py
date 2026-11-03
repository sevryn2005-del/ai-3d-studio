"""AI 3D Studio 백엔드 진입점.

- 로컬 모드:  uv run python -m app.local   (API + 빌드된 프론트엔드, 127.0.0.1, 브라우저 자동 열기)
- 개발 모드:  uv run uvicorn app.main:app --reload --port 8000   (프론트엔드는 Vite 가 제공)

LLM API 키 등 비밀 값은 이 로컬 서버에만 존재하며 브라우저로 보내지 않는다.
"""

from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from pathlib import Path

from fastapi import FastAPI
from fastapi.staticfiles import StaticFiles

from app import __version__
from app.api import ai, export, health, modeling
from app.ai.config_store import ConfigStore, default_data_dir
from app.ai.llm_client import AnthropicClient, LlmClient
from app.ai.usage_log import UsageLog
from collections.abc import Callable
from app.cad.worker_pool import WorkerPool
from app.core_limits import BodySizeLimitMiddleware
from app.core_security import LocalOnlyMiddleware
from app.settings import settings


def create_app(
    pool: WorkerPool | None = None,
    static_dir: str | None = None,
    allowed_hosts: frozenset[str] | None = None,
    data_dir: Path | None = None,
    llm_factory: Callable[[str], LlmClient] | None = None,
) -> FastAPI:
    @asynccontextmanager
    async def lifespan(app: FastAPI) -> AsyncIterator[None]:
        cad_pool = pool or WorkerPool(
            "app.cad.jobs", size=settings.cad_workers, job_timeout=settings.cad_job_timeout_s
        )
        cad_pool.start()  # 워커는 백그라운드에서 CadQuery 를 로드한다 (서버 시작을 막지 않음)
        app.state.cad_pool = cad_pool
        try:
            yield
        finally:
            cad_pool.close()

    app = FastAPI(title="AI 3D Studio API", version=__version__, lifespan=lifespan)
    # AI: 키·사용량은 이 PC 의 데이터 폴더에만 저장. 테스트는 대체 LLM 클라이언트를 주입한다.
    ai_dir = data_dir or default_data_dir()
    app.state.ai_store = ConfigStore(ai_dir)
    app.state.ai_usage = UsageLog(ai_dir)
    app.state.llm_factory = llm_factory or AnthropicClient
    app.add_middleware(BodySizeLimitMiddleware)
    app.add_middleware(LocalOnlyMiddleware, allowed_hosts=allowed_hosts or settings.allowed_hosts)
    app.include_router(health.router, prefix="/api")
    app.include_router(modeling.router, prefix="/api")
    app.include_router(export.router, prefix="/api")
    app.include_router(ai.router, prefix="/api")

    # 로컬 모드: 빌드된 프론트엔드를 같은 서버에서 제공 (API 라우터 뒤에 마운트해야 /api 가 우선)
    static = static_dir if static_dir is not None else settings.static_dir
    if static:
        if not (Path(static) / "index.html").exists():
            raise RuntimeError(f"프론트엔드 빌드를 찾을 수 없습니다: {static}")
        app.mount("/", StaticFiles(directory=static, html=True), name="frontend")
    return app


app = create_app()
