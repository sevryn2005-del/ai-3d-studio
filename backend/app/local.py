"""로컬 모드 실행기: 클라우드 서버 없이 개인 PC 에서 독립 실행.

사용:  uv run python -m app.local [--port 8765] [--no-browser]

- 127.0.0.1 에만 바인딩 (같은 네트워크의 다른 기기에서 접근 불가)
- API + 빌드된 프론트엔드를 한 프로세스에서 제공
- 서버가 준비되면 기본 브라우저로 자동 열기
"""

from __future__ import annotations

import argparse
import socket
import sys
import threading
import time
import urllib.request
import webbrowser

import uvicorn

from app.settings import settings

DEFAULT_PORT = 8765


def _port_free(host: str, port: int) -> bool:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        return s.connect_ex((host, port)) != 0


def _open_when_ready(url: str) -> None:
    for _ in range(100):
        try:
            with urllib.request.urlopen(f"{url}api/health", timeout=1):
                webbrowser.open(url)
                return
        except OSError:
            time.sleep(0.2)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="AI 3D Studio 로컬 모드")
    parser.add_argument("--port", type=int, default=DEFAULT_PORT)
    parser.add_argument("--no-browser", action="store_true", help="브라우저를 자동으로 열지 않음")
    args = parser.parse_args(argv)

    host = "127.0.0.1"
    if not settings.static_dir:
        print(
            "프론트엔드 빌드가 없습니다. 먼저 빌드하세요:\n"
            "  cd frontend && npm install && npm run build\n"
            "또는 AI3D_STATIC_DIR 환경 변수로 빌드 폴더를 지정하세요.",
            file=sys.stderr,
        )
        return 1
    if not _port_free(host, args.port):
        print(f"포트 {args.port} 이(가) 사용 중입니다. --port 로 다른 포트를 지정하세요.", file=sys.stderr)
        return 1

    url = f"http://{host}:{args.port}/"
    print(f"AI 3D Studio 로컬 모드: {url}  (종료: Ctrl+C)")
    if not args.no_browser:
        threading.Thread(target=_open_when_ready, args=(url,), daemon=True).start()

    from app.main import create_app

    uvicorn.run(create_app(), host=host, port=args.port, log_level="warning")
    return 0


if __name__ == "__main__":
    sys.exit(main())
