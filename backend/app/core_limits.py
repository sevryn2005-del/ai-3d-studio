"""요청 크기 제한 (ASGI 미들웨어).

CAD 요청은 작다. 비정상적으로 큰 요청은 파싱 전에 거부해 메모리 고갈을 막는다.
Content-Length 가 없는 chunked 전송도 실제 수신 바이트로 검사한다.
"""

from __future__ import annotations

import json

from starlette.types import ASGIApp, Message, Receive, Scope, Send

MAX_BODY_BYTES = 1_000_000  # 1 MB


class BodySizeLimitMiddleware:
    def __init__(self, app: ASGIApp, max_bytes: int = MAX_BODY_BYTES) -> None:
        self.app = app
        self.max_bytes = max_bytes

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        declared = dict(scope.get("headers") or []).get(b"content-length")
        if declared is not None and declared.isdigit() and int(declared) > self.max_bytes:
            await self._reject(send)
            return

        received = 0
        rejected = False
        response_started = False

        async def limited_receive() -> Message:
            # 예외를 던지면 FastAPI 가 400(본문 파싱 오류)으로 바꿔버리므로,
            # 한도 초과 시 여기서 직접 413 을 보내고 하위 앱에는 연결 종료를 알린다.
            nonlocal received, rejected
            if rejected:
                return {"type": "http.disconnect"}
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > self.max_bytes:
                    rejected = True
                    if not response_started:
                        await self._reject(send)
                    return {"type": "http.disconnect"}
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal response_started
            if rejected:
                return  # 이미 413 을 보냈으므로 하위 앱의 응답은 버린다
            if message["type"] == "http.response.start":
                response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            if not rejected:
                raise
            # 413 응답 이후 하위 앱에서 발생한 연결 종료 관련 예외는 무시

    async def _reject(self, send: Send) -> None:
        body = json.dumps(
            {"detail": f"요청이 너무 큽니다 (최대 {self.max_bytes // 1000}KB)"}, ensure_ascii=False
        ).encode()
        await send(
            {
                "type": "http.response.start",
                "status": 413,
                "headers": [(b"content-type", b"application/json; charset=utf-8")],
            }
        )
        await send({"type": "http.response.body", "body": body})
