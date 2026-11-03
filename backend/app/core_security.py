"""로컬 서버 보호 미들웨어.

로컬 모드 서버(127.0.0.1)는 사용자가 방문한 다른 웹사이트로부터 공격받을 수 있다.
- DNS rebinding: 악성 도메인을 127.0.0.1 로 바꿔 Host 헤더가 그 도메인인 요청을 보냄 → Host 검사로 차단.
- 교차 출처 요청: 다른 사이트의 페이지가 로컬 API 를 호출 → Origin 검사로 차단.
- 단순 요청(form, text/plain)은 CORS 사전 요청 없이 전송되므로 POST 는 JSON 만 허용.
AI 엔드포인트는 사용자의 API 키로 비용을 발생시키므로 이 보호가 필수다.
"""

from __future__ import annotations

import json
from urllib.parse import urlsplit

from starlette.types import ASGIApp, Receive, Scope, Send


class LocalOnlyMiddleware:
    def __init__(self, app: ASGIApp, allowed_hosts: frozenset[str]) -> None:
        self.app = app
        self.allowed_hosts = allowed_hosts

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        headers = {k.decode("latin-1").lower(): v.decode("latin-1") for k, v in scope.get("headers") or []}

        host = _hostname(headers.get("host", ""))
        if host not in self.allowed_hosts:
            await _deny(send, 421, "허용되지 않은 호스트입니다")
            return

        origin = headers.get("origin")
        if origin is not None and origin != "null" and _hostname(urlsplit(origin).netloc) not in self.allowed_hosts:
            await _deny(send, 403, "다른 사이트에서의 요청은 허용되지 않습니다")
            return
        if origin == "null":
            await _deny(send, 403, "출처가 없는 요청은 허용되지 않습니다")
            return

        if scope["method"] in {"POST", "PUT", "PATCH", "DELETE"} and scope["path"].startswith("/api/"):
            ctype = headers.get("content-type", "").split(";")[0].strip().lower()
            if ctype != "application/json":
                await _deny(send, 415, "JSON 요청만 허용됩니다")
                return

        await self.app(scope, receive, send)


def _hostname(netloc: str) -> str:
    """'localhost:8765' → 'localhost', '[::1]:8765' → '::1'"""
    if netloc.startswith("["):
        return netloc[1 : netloc.find("]")]
    return netloc.rsplit(":", 1)[0] if netloc.count(":") == 1 else netloc


async def _deny(send: Send, status: int, message: str) -> None:
    body = json.dumps({"detail": message}, ensure_ascii=False).encode()
    await send(
        {"type": "http.response.start", "status": status, "headers": [(b"content-type", b"application/json; charset=utf-8")]}
    )
    await send({"type": "http.response.body", "body": body})
