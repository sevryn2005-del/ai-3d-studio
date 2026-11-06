"""도면 투상 (숨은선 제거): 공유 픽스처 drawing-cases.json — 브라우저 occtDrawing.test.ts 와 같은 값."""

from __future__ import annotations

import copy
import math

import pytest

from app.cad.drawing import clean_hidden, dedupe_circles
from app.cad.jobs import drawing

from .conftest import load_json

CASES = load_json("examples/drawing-cases.json")


def length(lines) -> float:
    return sum(math.hypot(line[i] - line[i - 2], line[i + 1] - line[i - 1]) for line in lines for i in range(2, len(line) - 1, 2))


@pytest.mark.parametrize("name", sorted(CASES))
def test_shared_drawing_cases(name):
    case = CASES[name]
    names = [n for n in case["views"] if not n.startswith("aux")]
    views = drawing({"model": case["model"], "views": names, **({"section": case["section"]} if "section" in case else {}), **({"aux": case["aux"]} if "aux" in case else {})})
    assert sorted(v["name"] for v in views) == sorted(case["views"])
    for v in views:
        e = case["views"][v["name"]]
        if "axes" in e:
            assert length(v["axes"]) == pytest.approx(e["axes"], abs=1e-3)
        if "section" in e:
            assert length(v["section"]) == pytest.approx(e["section"], abs=0.05)
        else:
            assert "section" not in v
        if "visible" in e:
            assert length(v["visible"]) == pytest.approx(e["visible"], abs=0.05)
        if "hidden" in e:
            assert length(v["hidden"]) == pytest.approx(e["hidden"], abs=0.05)
        assert v["bounds"] == pytest.approx(e["bounds"], abs=1e-4)
        if "circles" in e:
            assert [c["radius"] for c in v["circles"] if c["full"] and c["visible"]] == e["circles"]


def test_hidden_object_skipped_and_empty_rejected():
    model = copy.deepcopy(CASES["object-behind-object"]["model"])
    for o in model["objects"]:
        if o["id"] == "b":
            o["hidden"] = True
    assert length(drawing({"model": model, "views": ["front"]})[0]["hidden"]) == pytest.approx(0)
    model["objects"] = []
    with pytest.raises(Exception, match="그릴 객체가 없습니다"):
        drawing({"model": model, "views": ["front"]})


def test_section_outside_shape():
    model = CASES["block-blind-hole"]["model"]
    with pytest.raises(Exception, match="단면 위치"):
        drawing({"model": model, "views": ["front"], "section": {"view": "front", "offset": 50}})
    v = drawing({"model": model, "views": ["front"], "section": {"view": "front", "offset": -50}})[0]
    assert length(v["visible"]) == pytest.approx(100, abs=1e-3) and v["hidden"] == []


def test_clean_hidden_rules():
    visible = [[0, 0, 10, 0]]
    # 보이는 선과 겹친 부분은 지우고, 같은 숨은선은 한 번만
    assert clean_hidden(visible, [[5, 0, 15, 0], [5, 0, 15, 0]]) == [[10, 0, 15, 0]]
    # 다른 직선 위는 그대로, 꺾은선은 이어진 채로
    assert clean_hidden(visible, [[0, 1, 5, 1, 5, 6]]) == [[0, 1, 5, 1, 5, 6]]
    half = {"center": [0, 0], "radius": 2, "full": False, "visible": False}
    assert dedupe_circles([half, {**half, "visible": True}]) == [{**half, "full": True, "visible": True}]


def test_api_drawing(client):
    case = CASES["block-blind-hole"]
    r = client.post("/api/model/drawing", json={"model": case["model"], "views": ["top"]}).json()
    assert r["ok"] and [v["name"] for v in r["views"]] == ["top"]
    bad = client.post("/api/model/drawing", json={"model": case["model"], "views": ["side"]}).json()
    assert not bad["ok"] and "front" in bad["issues"][0]["message"]
    sec = client.post("/api/model/drawing", json={"model": case["model"], "views": ["front"], "section": {"view": "front", "offset": 0}}).json()
    assert sec["ok"] and sec["views"][0]["section"]
    bad_sec = client.post("/api/model/drawing", json={"model": case["model"], "views": ["front"], "section": {"view": "top", "offset": 0}}).json()
    assert not bad_sec["ok"]


def test_api_aux_directions_validated(client):
    case = CASES["block-aux-45"]
    ok = client.post("/api/model/drawing", json={"model": case["model"], "views": ["front"], "aux": case["aux"]}).json()
    assert ok["ok"] and [v["name"] for v in ok["views"]] == ["front", "aux1"]
    for bad in ([{"toward": [1, 0, 0], "right": [1, 0, 0]}], [{"toward": [2, 0, 0], "right": [0, 1, 0]}], [{"toward": [1, 0, 0]}], [{"toward": [1, 0, 0], "right": [0, 1, 0]}] * 3):
        r = client.post("/api/model/drawing", json={"model": case["model"], "views": ["front"], "aux": bad}).json()
        assert not r["ok"] and r["issues"][0]["path"] == "aux"
