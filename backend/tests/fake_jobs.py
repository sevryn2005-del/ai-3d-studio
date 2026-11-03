"""WorkerPool 테스트용 작업 (CadQuery 없이 빠르게 실행)."""

import os
import time


class UserError(Exception):
    pass


USER_ERRORS = (UserError,)


def warmup() -> str:
    return "fake-engine 1.0"


JOBS = {
    "echo": lambda p: p,
    "sleep": lambda p: time.sleep(p) or "woke",
    "crash": lambda p: os._exit(1),
    "user_error": lambda p: (_ for _ in ()).throw(UserError("반지름이 너무 큽니다")),
    "bug": lambda p: 1 / 0,
}
