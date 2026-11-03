"""API 타임아웃 테스트용: 객체 이름이 'hang' 이면 멈추는 evaluate."""

import time


def evaluate(payload):
    if payload["objects"][0]["name"] == "hang":
        time.sleep(60)
    return {"meshes": [], "computeMs": 0}


JOBS = {"evaluate": evaluate}
