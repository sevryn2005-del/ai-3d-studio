"""환경 변수 기반 설정. 비밀 값(LLM API 키 등)은 3주 차부터 로컬 설정 파일/환경 변수에서 읽는다."""

import os
from dataclasses import dataclass, field
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parents[2]


def _default_static_dir() -> str:
    built = _REPO_ROOT / "frontend" / "dist"
    return str(built) if (built / "index.html").exists() else ""


@dataclass(frozen=True)
class Settings:
    cad_workers: int = int(os.environ.get("CAD_WORKERS", "2"))
    cad_job_timeout_s: float = float(os.environ.get("CAD_JOB_TIMEOUT_S", "20"))
    # 빌드된 프론트엔드 경로. 있으면 백엔드가 직접 제공한다 (로컬 모드: 프로세스 1개).
    static_dir: str = os.environ.get("AI3D_STATIC_DIR", _default_static_dir())
    # 요청을 받을 Host 이름. 로컬 전용이므로 루프백만 허용 (DNS rebinding 방지).
    allowed_hosts: frozenset[str] = field(
        default_factory=lambda: frozenset(
            h.strip() for h in os.environ.get("AI3D_ALLOWED_HOSTS", "127.0.0.1,localhost,::1").split(",") if h.strip()
        )
    )


settings = Settings()
