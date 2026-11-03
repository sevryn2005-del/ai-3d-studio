"""부모 프로세스 감시: 데스크톱 셸(Tauri)이 비정상 종료돼도 로컬 엔진이 남지 않게 한다.

Windows 에서 os.kill(pid, 0) 은 존재 확인이 아니라 프로세스를 종료시키므로 쓰지 않는다.
"""

from __future__ import annotations

import os
import sys
import threading
import time


def pid_alive(pid: int) -> bool:
    if pid <= 0:
        return False
    if sys.platform == "win32":
        import ctypes
        from ctypes import wintypes

        SYNCHRONIZE = 0x00100000
        WAIT_TIMEOUT = 0x00000102
        kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
        kernel32.OpenProcess.restype = wintypes.HANDLE
        handle = kernel32.OpenProcess(SYNCHRONIZE, False, pid)
        if not handle:
            return False
        try:
            return kernel32.WaitForSingleObject(handle, 0) == WAIT_TIMEOUT
        finally:
            kernel32.CloseHandle(handle)
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return False
    except PermissionError:
        return True
    return True


def exit_when_parent_dies(pid: int, interval_s: float = 1.0) -> threading.Thread:
    """pid 프로세스가 사라지면 이 프로세스를 즉시 종료한다 (워커는 파이프가 닫혀 스스로 끝난다)."""

    def watch() -> None:
        while pid_alive(pid):
            time.sleep(interval_s)
        os._exit(0)

    t = threading.Thread(target=watch, name="parent-watch", daemon=True)
    t.start()
    return t
