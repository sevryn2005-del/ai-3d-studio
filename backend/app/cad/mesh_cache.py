"""객체별 표시 메시 캐시 (API 프로세스, 모든 워커가 공유). CadQuery 를 쓰지 않는다.

키 = 그 객체의 하위 트리 + 쓰는 스케치 (+ 면 위 스케치면 모델 전체). 최상위 객체 자신의 위치는 로컬 메시와 무관해 뺀다.
무거운 형상(나사산 등)이 있어도 다른 곳을 고칠 때 다시 계산하지 않는다 — 프론트엔드 형상 키 캐시와 같은 원리.
"""

from __future__ import annotations

import hashlib
import json
import threading
from collections import OrderedDict
from typing import Any

from app.cad.commands import ModelDefinition, sketch_refs

CACHE_SIZE = 128


def cache_key(model: ModelDefinition, oid: str) -> str:
    index = {o.id: o for o in model.objects}
    ids: list[str] = []
    stack = [oid]
    while stack:
        cur = stack.pop()
        if cur in index and cur not in ids:
            ids.append(cur)
            stack.extend(index[cur].child_ids)
    refs = {r.sketch for i in ids for r in sketch_refs(index[i])}
    # 스케치 위치 패턴은 스케치 전체(원 중심)를 쓴다
    refs |= {index[i].pattern.sketch for i in ids if index[i].kind == "pattern" and index[i].pattern.type == "sketch"}
    sketches = [s for s in model.sketches if s.id in refs]
    parts: list[Any] = [index[i].model_dump(mode="json") for i in ids] + [s.model_dump(mode="json") for s in sketches]
    if parts and isinstance(parts[0], dict):
        parts[0] = {**parts[0], "transform": None, "name": None, "color": None, "hidden": None}
    if any(s.plane.type == "face" for s in sketches):  # 붙은 객체의 형상·위치에 따라 바뀐다
        parts.append(model.model_dump(mode="json"))
    return hashlib.sha256(json.dumps(parts, sort_keys=True, ensure_ascii=False).encode()).hexdigest()


class MeshCache:
    def __init__(self, size: int = CACHE_SIZE) -> None:
        self.size = size
        self._data: OrderedDict[str, dict[str, Any]] = OrderedDict()
        self._lock = threading.Lock()
        self._pending: dict[str, threading.Event] = {}

    def get(self, key: str) -> dict[str, Any] | None:
        with self._lock:
            v = self._data.get(key)
            if v is not None:
                self._data.move_to_end(key)
            return v

    def put(self, key: str, mesh: dict[str, Any]) -> None:
        with self._lock:
            self._data[key] = mesh
            self._data.move_to_end(key)
            while len(self._data) > self.size:
                self._data.popitem(last=False)

    def claim(self, keys: list[str]) -> tuple[list[str], list[threading.Event]]:
        """계산할 키를 맡는다: (내가 계산할 키, 다른 요청이 이미 계산 중이라 기다릴 이벤트).
        같은 형상을 여러 요청이 동시에 계산하지 않게 한다 (편집이 빠르게 이어질 때 워커가 밀리지 않도록)"""
        mine: list[str] = []
        waits: list[threading.Event] = []
        with self._lock:
            for k in keys:
                if k in self._data:
                    continue
                if k in self._pending:
                    waits.append(self._pending[k])
                else:
                    self._pending[k] = threading.Event()
                    mine.append(k)
        return mine, waits

    def release(self, keys: list[str]) -> None:
        """맡은 키의 계산이 끝났다 (성공·실패 모두) → 기다리던 요청을 깨운다"""
        with self._lock:
            for k in keys:
                ev = self._pending.pop(k, None)
                if ev is not None:
                    ev.set()

    def __len__(self) -> int:
        return len(self._data)
