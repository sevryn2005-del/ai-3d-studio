"""Windows 데스크톱 앱(Tauri)의 사이드카 진입점: PyInstaller 로 묶은 로컬 모드 엔진.

- 묶음 안의 web/ (프론트엔드 빌드)를 제공한다. 데이터(AI 설정·사용량)는 사용자 데이터 폴더.
- CAD 워커는 spawn 방식이므로 freeze_support 가 첫 줄이어야 한다 (워커 프로세스도 이 exe 로 시작된다).
"""

import multiprocessing
import os
import sys

if __name__ == "__main__":
    multiprocessing.freeze_support()
    # 데스크톱 앱은 출력을 기록 파일로 보낸다. Windows 기본 인코딩(cp1252·cp949)으로는 한글 출력이 실패할 수 있다.
    for stream in (sys.stdout, sys.stderr):
        if stream is not None and hasattr(stream, "reconfigure"):
            stream.reconfigure(encoding="utf-8", errors="replace")
    if getattr(sys, "frozen", False):
        os.environ.setdefault("AI3D_STATIC_DIR", os.path.join(sys._MEIPASS, "web"))  # type: ignore[attr-defined]

    from app.local import main

    sys.exit(main())
