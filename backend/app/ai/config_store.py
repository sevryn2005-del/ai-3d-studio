"""AI 설정 (사용자 API 키 BYOK, 모델, 가격표) — 이 PC 의 로컬 데이터 폴더에만 저장한다.

- 키는 브라우저·로그·프로젝트 파일로 내보내지 않는다. API 응답에는 끝 4자리만 보인다.
- 파일은 소유자만 읽을 수 있게(0600) 원자적으로 쓴다.
- 키를 저장하지 않았으면 환경 변수 ANTHROPIC_API_KEY 를 사용한다.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path
from typing import Any

from pydantic import BaseModel, Field

from app.ai.llm_client import DEFAULT_MODEL


def default_data_dir() -> Path:
    env = os.environ.get("AI3D_DATA_DIR")
    if env:
        return Path(env)
    if sys.platform == "win32":
        return Path(os.environ.get("APPDATA", Path.home())) / "AI3DStudio"
    if sys.platform == "darwin":
        return Path.home() / "Library" / "Application Support" / "AI3DStudio"
    return Path(os.environ.get("XDG_DATA_HOME", Path.home() / ".local" / "share")) / "ai3dstudio"


class Price(BaseModel):
    """USD / 100만 토큰 (예상 비용 계산용, 사용자가 수정 가능)"""

    input: float = Field(ge=0)
    output: float = Field(ge=0)
    cacheRead: float = Field(ge=0)
    cacheWrite: float = Field(ge=0)


# 2026-10 기준 Anthropic 공개 가격. 캐시 쓰기는 입력의 1.25배 (5분 캐시).
MODELS: dict[str, dict[str, Any]] = {
    "claude-opus-5-5": {"label": "Claude Opus 5.5 (권장)", "price": Price(input=4.0, output=20.0, cacheRead=0.20, cacheWrite=5.0)},
    "claude-sonnet-5-5": {"label": "Claude Sonnet 5.5", "price": Price(input=2.0, output=10.0, cacheRead=0.20, cacheWrite=2.5)},
    "claude-haiku-5-5": {"label": "Claude Haiku 5.5", "price": Price(input=0.10, output=0.50, cacheRead=0.01, cacheWrite=0.125)},
}


class StoredSettings(BaseModel):
    apiKey: str | None = None
    model: str = DEFAULT_MODEL
    enabled: bool = True
    prices: dict[str, Price] = Field(default_factory=dict)  # 사용자가 바꾼 가격만


class ConfigStore:
    def __init__(self, data_dir: Path) -> None:
        self.dir = data_dir
        self.path = data_dir / "ai-settings.json"

    def load(self) -> StoredSettings:
        try:
            return StoredSettings.model_validate_json(self.path.read_text(encoding="utf-8"))
        except (FileNotFoundError, ValueError):
            return StoredSettings()

    def save(self, s: StoredSettings) -> None:
        self.dir.mkdir(parents=True, exist_ok=True)
        fd, tmp = tempfile.mkstemp(dir=self.dir, prefix=".ai-settings-")
        try:
            os.chmod(tmp, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as f:
                f.write(s.model_dump_json(indent=2))
            os.replace(tmp, self.path)
        except BaseException:
            Path(tmp).unlink(missing_ok=True)
            raise

    # ---- 조회 헬퍼 -------------------------------------------------------------

    @staticmethod
    def effective_key(s: StoredSettings) -> tuple[str | None, str | None]:
        """(키, 출처). 출처: 'saved' | 'environment' | None"""
        if s.apiKey:
            return s.apiKey, "saved"
        env = os.environ.get("ANTHROPIC_API_KEY")
        return (env, "environment") if env else (None, None)

    @staticmethod
    def price_for(s: StoredSettings, model: str) -> Price:
        if model in s.prices:
            return s.prices[model]
        return MODELS.get(model, MODELS[DEFAULT_MODEL])["price"]

    def public_view(self, s: StoredSettings) -> dict[str, Any]:
        key, source = self.effective_key(s)
        return {
            "enabled": s.enabled,
            "model": s.model,
            "keyConfigured": key is not None,
            "keySource": source,
            "keyHint": f"…{key[-4:]}" if key and len(key) >= 8 else None,
            "models": [
                {"id": mid, "label": m["label"], "price": self.price_for(s, mid).model_dump()} for mid, m in MODELS.items()
            ],
        }


def estimate_cost(price: Price, *, input_tokens: int, output_tokens: int, cache_read: int, cache_write: int) -> float:
    return (
        input_tokens * price.input
        + output_tokens * price.output
        + cache_read * price.cacheRead
        + cache_write * price.cacheWrite
    ) / 1_000_000
