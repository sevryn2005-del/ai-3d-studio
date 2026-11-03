"""AI 사용량·예상 비용 기록 (로컬 JSONL). 요청 1건(사용자 메시지 1개) = 1줄.

예상 비용은 설정의 가격표로 계산한 추정치다. 실제 청구액은 Anthropic 콘솔에서 확인한다
(서버 측 대체 모델로 처리된 요청 등은 가격이 다를 수 있다).
"""

from __future__ import annotations

import json
import threading
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

_LOCK = threading.Lock()


class UsageLog:
    def __init__(self, data_dir: Path) -> None:
        self.path = data_dir / "ai-usage.jsonl"

    def append(self, record: dict[str, Any]) -> dict[str, Any]:
        rec = {"time": datetime.now(timezone.utc).isoformat(timespec="seconds"), **record}
        with _LOCK:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            with self.path.open("a", encoding="utf-8") as f:
                f.write(json.dumps(rec, ensure_ascii=False) + "\n")
        return rec

    def records(self) -> list[dict[str, Any]]:
        try:
            lines = self.path.read_text(encoding="utf-8").splitlines()
        except FileNotFoundError:
            return []
        out = []
        for line in lines:
            try:
                out.append(json.loads(line))
            except ValueError:
                continue  # 손상된 줄은 건너뛴다
        return out

    def summary(self, now: datetime | None = None, recent: int = 20) -> dict[str, Any]:
        now = (now or datetime.now(timezone.utc)).astimezone()
        recs = self.records()

        def total(filter_fn) -> dict[str, Any]:
            sel = [r for r in recs if filter_fn(datetime.fromisoformat(r["time"]).astimezone())]
            return {
                "requests": len(sel),
                "inputTokens": sum(r.get("inputTokens", 0) + r.get("cacheReadTokens", 0) + r.get("cacheWriteTokens", 0) for r in sel),
                "outputTokens": sum(r.get("outputTokens", 0) for r in sel),
                "costUsd": round(sum(r.get("costUsd", 0.0) for r in sel), 6),
            }

        return {
            "today": total(lambda t: t.date() == now.date()),
            "month": total(lambda t: (t.year, t.month) == (now.year, now.month)),
            "all": total(lambda t: True),
            "recent": list(reversed(recs[-recent:])),
        }
