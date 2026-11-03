"""데스크톱 셸이 사라지면 엔진도 종료되는지 (부모 감시)."""

import os
import subprocess
import sys
import time

from app.parent_watch import pid_alive


def test_pid_alive():
    assert pid_alive(os.getpid())
    assert not pid_alive(0)
    p = subprocess.Popen([sys.executable, "-c", "pass"])
    p.wait()
    assert not pid_alive(p.pid)


def test_child_exits_when_parent_dies():
    parent = subprocess.Popen([sys.executable, "-c", "import time; time.sleep(30)"])
    code = (
        "import time; from app.parent_watch import exit_when_parent_dies; "
        f"exit_when_parent_dies({parent.pid}, 0.1); time.sleep(30)"
    )
    child = subprocess.Popen([sys.executable, "-c", code], cwd=os.path.dirname(os.path.dirname(__file__)))
    try:
        time.sleep(0.5)
        assert child.poll() is None
        parent.kill()
        parent.wait()
        child.wait(timeout=5)
        assert child.returncode == 0
    finally:
        parent.kill()
        child.kill()
