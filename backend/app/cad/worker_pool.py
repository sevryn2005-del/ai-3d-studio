"""CAD 연산 격리 워커 풀.

OCCT(C++)는 무한 루프·세그폴트·메모리 폭증이 가능하므로 API 프로세스에서 직접 실행하지 않는다.
- 워커 프로세스를 미리 띄워 둔다 (CadQuery import 에 수 초가 걸리므로 요청마다 띄우지 않음).
- 작업마다 타임아웃. 초과하면 그 워커를 강제 종료하고 새 워커로 교체한다.
- 워커가 비정상 종료해도 감지하여 교체한다. 서버 본체는 영향을 받지 않는다.
- 워커는 jobs 모듈의 JOBS 레지스트리에 등록된 함수만 실행한다 (임의 코드 실행 없음).
- Windows 호환을 위해 'spawn' 시작 방식을 사용한다.
"""

from __future__ import annotations

import importlib
import logging
import multiprocessing as mp
import queue
import threading
import time
import traceback
from multiprocessing.connection import Connection
from typing import Any

log = logging.getLogger(__name__)

_CTX = mp.get_context("spawn")


class CadEngineError(Exception):
    """사용자에게 보여줄 수 있는 한국어 메시지를 가진 엔진 오류의 기반 클래스."""


class JobTimeout(CadEngineError):
    pass


class WorkerCrashed(CadEngineError):
    pass


class PoolBusy(CadEngineError):
    pass


class JobFailed(CadEngineError):
    """작업 함수가 예외를 던짐. user_message 가 있으면 사용자용, 없으면 일반 메시지."""


# ---- 워커 프로세스 쪽 -----------------------------------------------------------


def _worker_main(conn: Connection, jobs_module: str) -> None:
    try:
        module = importlib.import_module(jobs_module)
        info = module.warmup() if hasattr(module, "warmup") else ""
        conn.send(("ready", info))
    except BaseException:  # noqa: BLE001 — 시작 실패는 부모에게 알리고 종료
        conn.send(("startup_error", traceback.format_exc()))
        return

    user_errors: tuple[type[BaseException], ...] = getattr(module, "USER_ERRORS", ())
    while True:
        try:
            job, payload = conn.recv()
        except (EOFError, OSError):
            return
        fn = module.JOBS.get(job)
        if fn is None:
            conn.send(("error", f"알 수 없는 작업입니다: {job}", None))
            continue
        try:
            conn.send(("ok", fn(payload), None))
        except user_errors as e:
            conn.send(("error", str(e), None))
        except Exception:  # noqa: BLE001
            conn.send(("error", None, traceback.format_exc()))


# ---- 부모(API) 프로세스 쪽 -------------------------------------------------------


class _Worker:
    def __init__(self, jobs_module: str) -> None:
        self.conn, child = _CTX.Pipe()
        self.process = _CTX.Process(target=_worker_main, args=(child, jobs_module), daemon=True)
        self.process.start()
        child.close()
        self.ready = False
        self.info = ""

    def wait_ready(self, timeout: float) -> None:
        if self.ready:
            return
        if not self.conn.poll(timeout):
            raise WorkerCrashed("CAD 엔진 시작이 지연되고 있습니다")
        try:
            kind, data = self.conn.recv()
        except EOFError as e:
            raise WorkerCrashed("CAD 엔진 시작에 실패했습니다") from e
        if kind != "ready":
            log.error("CAD 워커 시작 실패:\n%s", data)
            raise WorkerCrashed("CAD 엔진 시작에 실패했습니다")
        self.ready, self.info = True, data

    def kill(self) -> None:
        if self.process.is_alive():
            self.process.kill()
        self.process.join(timeout=5)
        self.conn.close()


class WorkerPool:
    def __init__(
        self,
        jobs_module: str,
        size: int = 2,
        job_timeout: float = 20.0,
        startup_timeout: float = 120.0,
        acquire_timeout: float = 30.0,
    ) -> None:
        self.jobs_module = jobs_module
        self.size = size
        self.job_timeout = job_timeout
        self.startup_timeout = startup_timeout
        self.acquire_timeout = acquire_timeout
        self._idle: queue.Queue[_Worker] = queue.Queue()
        self._all: set[_Worker] = set()
        self._lock = threading.Lock()
        self.engine_info = ""
        self.restarts = 0

    # 수명 주기
    def start(self) -> None:
        for _ in range(self.size):
            self._add_worker()

    def close(self) -> None:
        with self._lock:
            workers, self._all = list(self._all), set()
        for w in workers:
            w.kill()

    @property
    def is_ready(self) -> bool:
        return bool(self.engine_info)

    def _add_worker(self) -> None:
        w = _Worker(self.jobs_module)
        with self._lock:
            self._all.add(w)
        self._idle.put(w)

    def _replace(self, w: _Worker) -> None:
        w.kill()
        with self._lock:
            self._all.discard(w)
            self.restarts += 1
        self._add_worker()

    # 작업 실행 (스레드 안전: FastAPI 의 동기 엔드포인트는 스레드 풀에서 실행됨)
    def run(self, job: str, payload: Any, timeout: float | None = None) -> Any:
        try:
            w = self._idle.get(timeout=self.acquire_timeout)
        except queue.Empty as e:
            raise PoolBusy("CAD 엔진이 바쁩니다. 잠시 후 다시 시도하세요") from e

        try:
            w.wait_ready(self.startup_timeout)  # 시작 시간은 작업 타임아웃에 포함하지 않는다
            self.engine_info = self.engine_info or w.info
        except WorkerCrashed:
            self._replace(w)
            raise

        limit = timeout or self.job_timeout
        started = time.monotonic()
        try:
            w.conn.send((job, payload))
            if not w.conn.poll(limit):
                log.warning("CAD 작업 타임아웃 (%s, %.1fs) → 워커 교체", job, limit)
                self._replace(w)
                raise JobTimeout(f"형상 계산이 제한 시간({limit:g}초)을 초과했습니다")
            status, message, tb = w.conn.recv()
        except (EOFError, OSError, BrokenPipeError) as e:
            log.error("CAD 워커 비정상 종료 (%s, exitcode=%s) → 워커 교체", job, w.process.exitcode)
            self._replace(w)
            raise WorkerCrashed("형상 계산 중 CAD 엔진이 비정상 종료되었습니다") from e

        self._idle.put(w)
        log.debug("CAD 작업 %s 완료 (%.0fms)", job, (time.monotonic() - started) * 1000)
        if status == "ok":
            return message
        if tb:
            log.error("CAD 작업 %s 내부 오류:\n%s", job, tb)
            raise JobFailed("형상 계산 중 내부 오류가 발생했습니다")
        raise JobFailed(message)
