import threading

import pytest

from app.cad.worker_pool import JobFailed, JobTimeout, WorkerCrashed, WorkerPool


@pytest.fixture
def pool():
    p = WorkerPool("tests.fake_jobs", size=1, job_timeout=2)
    p.start()
    yield p
    p.close()


def test_runs_job_and_reports_engine(pool):
    assert pool.run("echo", {"a": [1, 2]}) == {"a": [1, 2]}
    assert pool.engine_info == "fake-engine 1.0"


def test_timeout_kills_worker_and_pool_recovers(pool):
    with pytest.raises(JobTimeout, match="제한 시간"):
        pool.run("sleep", 30, timeout=0.5)
    assert pool.restarts == 1
    assert pool.run("echo", "still alive") == "still alive"


def test_crash_is_isolated_and_recovered(pool):
    with pytest.raises(WorkerCrashed):
        pool.run("crash", None)
    assert pool.run("echo", 42) == 42


def test_user_error_message_is_passed_through(pool):
    with pytest.raises(JobFailed, match="반지름이 너무 큽니다"):
        pool.run("user_error", None)
    assert pool.restarts == 0  # 일반 오류는 워커를 교체하지 않음


def test_internal_error_is_hidden_from_user(pool):
    with pytest.raises(JobFailed, match="내부 오류") as e:
        pool.run("bug", None)
    assert "ZeroDivision" not in str(e.value)


def test_unknown_job_is_rejected(pool):
    with pytest.raises(JobFailed, match="알 수 없는 작업"):
        pool.run("os.system", "rm -rf /")


def test_concurrent_jobs_use_multiple_workers():
    p = WorkerPool("tests.fake_jobs", size=2, job_timeout=5)
    p.start()
    try:
        p.run("echo", 0)  # 시작 대기
        p.run("echo", 0)
        results = []
        threads = [threading.Thread(target=lambda: results.append(p.run("sleep", 0.5))) for _ in range(2)]
        import time

        t0 = time.monotonic()
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert results == ["woke", "woke"]
        assert time.monotonic() - t0 < 0.95  # 병렬 실행
    finally:
        p.close()
