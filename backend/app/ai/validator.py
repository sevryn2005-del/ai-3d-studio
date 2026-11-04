"""AI 가 만든 명령 목록의 실행 전 검증 (스키마 + 현재 모델 기준 참조 검사).

실제 실행은 프론트엔드 실행기가 한 단계(실행 취소 1회)로 원자적으로 한다. 여기서는 AI 에게 고칠 기회를
주기 위해 흔한 오류를 미리 잡는다: 없는 객체, 도형에 없는 파라미터, 불리언에 이미 포함된 피연산자,
중복 ID. 오류 메시지는 AI 가 읽고 고칠 수 있도록 구체적으로 쓴다.
"""

from __future__ import annotations

from typing import Any

from pydantic import ValidationError

from app.cad.commands import (
    BooleanObject,
    PatternObject,
    CadCommandAdapter,
    ExtrudeObject,
    sketch_feature_ref,
    FacePlane,
    ModelDefinition,
    PARAMS_MODELS,
    REQUIRED_DIMENSIONS,
)
from app.cad.constraints import ARITY as CONSTRAINT_ARITY, polygon_error
from app.cad.validation import issues_from_validation_error

_CREATE_KIND = {"create_box": "box", "create_cylinder": "cylinder", "create_sphere": "sphere", "create_cone": "cone"}


def validate_commands(raw: Any, model: ModelDefinition) -> tuple[list[dict[str, Any]], list[str]]:
    """(정규화된 명령 목록, 오류 목록). 오류가 하나라도 있으면 명령은 적용하면 안 된다."""
    if not isinstance(raw, list) or not raw:
        return [], ["commands must be a non-empty array"]

    commands: list[dict[str, Any]] = []
    errors: list[str] = []
    for i, item in enumerate(raw):
        try:
            cmd = CadCommandAdapter.validate_python(item)
        except ValidationError as e:
            for issue in issues_from_validation_error(e):
                where = f".{issue.path}" if issue.path else ""
                errors.append(f"commands[{i}]{where}: {issue.message}")
            continue
        commands.append(cmd.model_dump(mode="json", exclude_unset=True))
    if errors:
        return [], errors

    # 현재 모델 상태를 따라가며 참조 검사
    kinds: dict[str, str] = {o.id: o.kind for o in model.objects}
    # 스케치 id → 요소 id → 요소 유형 (객체와 스케치는 ID 이름공간을 공유한다)
    sketches: dict[str, dict[str, str]] = {sk.id: {e.id: e.type for e in sk.entities} for sk in model.sketches}
    # 구속 해석기: 다각형 꼭짓점 수, 구속 id → 값이 있는지 (참조 형식은 app/cad/constraints.ARITY)
    poly_sizes: dict[tuple[str, str], int] = {
        (sk.id, e.id): len(e.points) for sk in model.sketches for e in sk.entities if e.type in ("polygon", "line", "path")
    }
    constraint_ids: dict[str, dict[str, bool]] = {sk.id: {c.id: c.value is not None for c in sk.constraints} for sk in model.sketches}

    def geom_kind(sid: str, ref: str) -> str | None:
        eid, _, part = ref.partition(".")
        etype = sketches.get(sid, {}).get(eid)
        if etype is None:
            return None
        if not part:
            return "circle" if etype == "circle" else None
        if part == "center":
            return None if etype in ("polygon", "line", "path") else "point"
        if etype not in ("polygon", "line", "path"):
            return None
        size = poly_sizes.get((sid, eid), 0)
        limit = size - 1 if (part[0] == "e" and etype != "polygon") else size
        if int(part[1:]) >= limit:
            return None
        return "point" if part[0] == "p" else "edge"

    def refs_ok(i: int, sid: str, ctype: str, refs: list[str], value) -> None:
        kinds_ = [geom_kind(sid, r) for r in refs]
        for r, k in zip(refs, kinds_):
            if k is None:
                errors.append(f"commands[{i}].refs: sketch '{sid}' has no point/edge/circle '{r}' "
                              "(points: '<polygon>.p0', '<circle or rectangle>.center'; edges: '<polygon>.e0'; circles: '<circle id>')")
                return
        forms, needs_value = CONSTRAINT_ARITY[ctype]
        if tuple(kinds_) not in forms:
            expected = " or ".join(" + ".join(f) for f in forms)
            errors.append(f"commands[{i}].refs: {ctype} needs {expected}, got {' + '.join(kinds_)}")
        elif needs_value and value is None:
            errors.append(f"commands[{i}].value: {ctype} needs a value in mm")
        elif not needs_value and value is not None:
            errors.append(f"commands[{i}].value: {ctype} takes no value")
    # 돌출 객체 id → (스케치, 프로파일): 참조 중인 스케치·요소 삭제를 막기 위해
    extrude_refs: dict[str, tuple[str, str]] = {
        o.id: (ref.sketch, ref.profile) for o in model.objects if (ref := sketch_feature_ref(o))
    }

    # 면 위 스케치: 스케치 → 붙은 객체, 불리언 → 기준 객체 (면 이름은 기준 객체 종류로 정한다)
    anchors: dict[str, str] = {sk.id: sk.plane.object for sk in model.sketches if isinstance(sk.plane, FacePlane)}
    bases: dict[str, str] = {o.id: o.boolean.base for o in model.objects if isinstance(o, BooleanObject)}
    bases.update({o.id: o.pattern.source for o in model.objects if isinstance(o, PatternObject)})

    def allowed_faces(oid: str, depth: int = 0) -> list[str]:
        kind = kinds.get(oid)
        if kind == "box":
            return ["top", "bottom", "+X", "-X", "+Y", "-Y"]
        if kind in ("cylinder", "cone"):
            return ["top", "bottom"]
        if kind == "extrude":
            sid, eid = extrude_refs.get(oid, ("", ""))
            rect = sketches.get(sid, {}).get(eid) == "rectangle"
            return ["end", "start", "+u", "-u", "+v", "-v"] if rect else ["end", "start"]
        if kind in ("boolean", "pattern") and oid in bases and depth < 16:
            return allowed_faces(bases[oid], depth + 1)
        return []

    def plane_ok(i: int, plane: dict | None, sid: str | None) -> None:
        if not plane or plane.get("type") != "face":
            if sid:
                anchors.pop(sid, None)
            return
        if not exists(i, plane["object"], "plane.object"):
            return
        faces = allowed_faces(plane["object"])
        if plane["face"] not in faces:
            errors.append(
                f"commands[{i}].plane.face: {kinds[plane['object']]} '{plane['object']}' has no face '{plane['face']}' "
                f"(faces: {', '.join(faces) or 'none'})"
            )
        elif sid:
            anchors[sid] = plane["object"]

    def users_of(sid: str, eid: str | None = None) -> list[str]:
        return sorted(o for o, (s_, p_) in extrude_refs.items() if s_ == sid and (eid is None or p_ == eid))

    def id_used(oid: str) -> bool:
        return oid in kinds or oid in sketches

    def sketch_exists(i: int, sid: str) -> bool:
        if sid in sketches:
            return True
        errors.append(f"commands[{i}].sketch: sketch '{sid}' does not exist (existing: {', '.join(sorted(sketches)) or 'none'})")
        return False

    def next_entity_id(entities: dict[str, str], prefix: str) -> str:
        n = 1
        while f"{prefix}{n}" in entities:
            n += 1
        return f"{prefix}{n}"
    parent: dict[str, str] = {}
    for o in model.objects:
        for c in o.child_ids:
            parent[c] = o.id

    def exists(i: int, oid: str, role: str) -> bool:
        if oid in kinds:
            return True
        errors.append(f"commands[{i}].{role}: object '{oid}' does not exist (existing: {', '.join(sorted(kinds)) or 'none'})")
        return False

    for i, c in enumerate(commands):
        t = c["type"]
        if t in _CREATE_KIND:
            oid = c.get("id")
            if oid is None:
                continue  # 이름 자동 생성: 이후 참조할 수 없음
            if id_used(oid):
                errors.append(f"commands[{i}].id: id '{oid}' is already used")
            kinds[oid] = _CREATE_KIND[t]
        elif t == "create_sketch":
            sid = c.get("id")
            plane_ok(i, c.get("plane"), sid)
            if sid is None:
                continue  # 자동 이름: 같은 묶음에서 참조할 수 없음
            if id_used(sid):
                errors.append(f"commands[{i}].id: id '{sid}' is already used")
            sketches[sid] = {}
        elif t in ("add_rectangle", "add_circle"):
            if sketch_exists(i, c["sketch"]):
                ents = sketches[c["sketch"]]
                etype = "rectangle" if t == "add_rectangle" else "circle"
                eid = c.get("id") or next_entity_id(ents, "rect" if etype == "rectangle" else "circle")
                if eid in ents:
                    errors.append(f"commands[{i}].id: sketch '{c['sketch']}' already has an element '{eid}'")
                ents[eid] = etype
        elif t == "add_polygon":
            if sketch_exists(i, c["sketch"]):
                ents = sketches[c["sketch"]]
                eid = c.get("id") or next_entity_id(ents, "poly")
                if eid in ents:
                    errors.append(f"commands[{i}].id: sketch '{c['sketch']}' already has an element '{eid}'")
                elif err := polygon_error(c["points"]):
                    errors.append(f"commands[{i}].points: {err}")
                ents[eid] = "polygon"
                poly_sizes[(c["sketch"], eid)] = len(c["points"])
        elif t == "offset_entity":
            if sketch_exists(i, c["sketch"]):
                ents = sketches[c["sketch"]]
                if c["entity"] not in ents or ents[c["entity"]] in ("line", "path"):
                    errors.append(f"commands[{i}].entity: sketch '{c['sketch']}' has no closed element '{c['entity']}'")
                else:
                    etype = ents[c["entity"]]
                    eid = c.get("id") or next_entity_id(ents, "rect" if etype == "rectangle" else etype)
                    if eid in ents:
                        errors.append(f"commands[{i}].id: sketch '{c['sketch']}' already has an element '{eid}'")
                    ents[eid] = etype
        elif t in ("helix", "loft"):
            refs = [(c["sketch"], c["profile"])] if t == "helix" else [(s["sketch"], s["profile"]) for s in c["sections"]]
            for sid, pid in refs:
                if sketch_exists(i, sid) and (pid not in sketches[sid] or sketches[sid][pid] in ("line", "path")):
                    errors.append(f"commands[{i}]: sketch '{sid}' has no closed profile '{pid}'")
            new_id = c.get("id")
            if new_id is not None:
                if id_used(new_id):
                    errors.append(f"commands[{i}].id: id '{new_id}' is already used")
                kinds[new_id] = t
                extrude_refs[new_id] = refs[0]
        elif t == "add_path":
            if sketch_exists(i, c["sketch"]):
                ents = sketches[c["sketch"]]
                eid = c.get("id") or next_entity_id(ents, "path")
                if eid in ents:
                    errors.append(f"commands[{i}].id: sketch '{c['sketch']}' already has an element '{eid}'")
                ents[eid] = "path"
                poly_sizes[(c["sketch"], eid)] = len(c["points"])
        elif t == "set_corner":
            if sketch_exists(i, c["sketch"]) and sketches[c["sketch"]].get(c["entity"]) not in ("polygon", "path"):
                errors.append(f"commands[{i}].entity: '{c['entity']}' is not a polygon or path of sketch '{c['sketch']}' "
                              "(sketch fillet/chamfer works on polygon and path vertices; draw a rectangle as add_polygon to round it)")
        elif t == "sweep":
            if sketch_exists(i, c["sketch"]) and sketches[c["sketch"]].get(c["profile"]) in (None, "line", "path"):
                errors.append(f"commands[{i}].profile: sketch '{c['sketch']}' has no closed profile '{c['profile']}'")
            if sketch_exists(i, c["pathSketch"]) and sketches[c["pathSketch"]].get(c["path"]) not in ("line", "path"):
                errors.append(f"commands[{i}].path: sketch '{c['pathSketch']}' has no path or line '{c['path']}' (add one with add_path)")
            new_id = c.get("id")
            if new_id is not None:
                if id_used(new_id):
                    errors.append(f"commands[{i}].id: id '{new_id}' is already used")
                kinds[new_id] = "sweep"
        elif t == "set_thin":
            if exists(i, c["target"], "target") and kinds[c["target"]] != "extrude":
                errors.append(f"commands[{i}].target: '{c['target']}' is not a rib (extrude with thin)")
        elif t == "import_mesh":
            errors.append(f"commands[{i}]: import_mesh is only for files the user opens, not for AI")
        elif t in ("add_line", "add_slot"):
            if sketch_exists(i, c["sketch"]):
                ents = sketches[c["sketch"]]
                etype = "line" if t == "add_line" else "slot"
                eid = c.get("id") or next_entity_id(ents, etype)
                if eid in ents:
                    errors.append(f"commands[{i}].id: sketch '{c['sketch']}' already has an element '{eid}'")
                ents[eid] = etype
                if etype == "line":
                    poly_sizes[(c["sketch"], eid)] = 2
        elif t == "set_entity_angle":
            if sketch_exists(i, c["sketch"]) and sketches[c["sketch"]].get(c["entity"]) != "slot":
                errors.append(f"commands[{i}].entity: '{c['entity']}' is not a slot of sketch '{c['sketch']}'")
        elif t == "move_point":
            if sketch_exists(i, c["sketch"]) and geom_kind(c["sketch"], c["point"]) != "point":
                errors.append(f"commands[{i}].point: '{c['point']}' is not a point of sketch '{c['sketch']}' "
                              "(use '<polygon>.p0' or '<circle or rectangle>.center')")
        elif t == "add_constraint":
            if sketch_exists(i, c["sketch"]):
                refs_ok(i, c["sketch"], c["constraint"], c["refs"], c.get("value"))
                known = constraint_ids.setdefault(c["sketch"], {})
                cid = c.get("id")
                if cid is None:  # 프론트엔드 실행기와 같은 자동 이름: k1, k2, …
                    n = 1
                    while f"k{n}" in known:
                        n += 1
                    cid = f"k{n}"
                elif cid in known:
                    errors.append(f"commands[{i}].id: constraint id '{cid}' is already used in sketch '{c['sketch']}'")
                known[cid] = c.get("value") is not None
        elif t in ("set_constraint", "delete_constraint"):
            if sketch_exists(i, c["sketch"]):
                known = constraint_ids.setdefault(c["sketch"], {})
                if c["constraint"] not in known:
                    errors.append(f"commands[{i}].constraint: sketch '{c['sketch']}' has no constraint '{c['constraint']}' "
                                  f"(existing: {', '.join(sorted(known)) or 'none'})")
                elif t == "set_constraint" and not known[c["constraint"]]:
                    errors.append(f"commands[{i}].constraint: '{c['constraint']}' has no value to set")
                elif t == "delete_constraint":
                    known.pop(c["constraint"])
        elif t == "set_dimension":
            if sketch_exists(i, c["sketch"]):
                ents = sketches[c["sketch"]]
                eid, kind = c["dimension"].split(".", 1)
                allowed = [f"{e}.{k}" for e, et in sorted(ents.items()) for k in REQUIRED_DIMENSIONS[et]]
                if ents.get(eid) is None or kind not in REQUIRED_DIMENSIONS[ents[eid]]:
                    errors.append(
                        f"commands[{i}].dimension: sketch '{c['sketch']}' has no dimension '{c['dimension']}' (existing: {', '.join(allowed) or 'none'})"
                    )
        elif t in ("set_entity_center", "delete_sketch_entity"):
            if sketch_exists(i, c["sketch"]):
                ents = sketches[c["sketch"]]
                if c["entity"] not in ents:
                    errors.append(f"commands[{i}].entity: sketch '{c['sketch']}' has no element '{c['entity']}' (existing: {', '.join(sorted(ents)) or 'none'})")
                elif t == "delete_sketch_entity":
                    if users := users_of(c["sketch"], c["entity"]):
                        errors.append(f"commands[{i}].entity: '{c['entity']}' is used by extrude {', '.join(users)}; delete those objects first")
                    else:
                        ents.pop(c["entity"])
        elif t == "rename_sketch":
            sketch_exists(i, c["sketch"])
        elif t == "set_sketch_plane":
            if sketch_exists(i, c["sketch"]):
                plane_ok(i, c["plane"], c["sketch"])
        elif t == "delete_sketch":
            if sketch_exists(i, c["sketch"]):
                if users := users_of(c["sketch"]):
                    errors.append(f"commands[{i}].sketch: sketch '{c['sketch']}' is used by extrude {', '.join(users)}; delete those objects first")
                else:
                    sketches.pop(c["sketch"])
        elif t in ("extrude", "revolve"):
            if sketch_exists(i, c["sketch"]) and c["profile"] not in sketches[c["sketch"]]:
                existing = ", ".join(sorted(sketches[c["sketch"]])) or "none"
                errors.append(f"commands[{i}].profile: sketch '{c['sketch']}' has no element '{c['profile']}' (existing: {existing})")
            elif sketch_exists(i, c["sketch"]):
                is_open = sketches[c["sketch"]][c["profile"]] in ("line", "path")
                if c.get("thin") is not None and not is_open:
                    errors.append(f"commands[{i}].thin: thin (rib) needs an open line or path, '{c['profile']}' is closed")
                elif c.get("thin") is None and is_open:
                    errors.append(f"commands[{i}].profile: '{c['profile']}' is an open line; give thin (thickness) to extrude it as a rib")
            new_id = c.get("id")
            if new_id is not None:
                if id_used(new_id):
                    errors.append(f"commands[{i}].id: id '{new_id}' is already used")
                kinds[new_id] = t
                extrude_refs[new_id] = (c["sketch"], c["profile"])
        elif t in ("cut", "union", "intersect"):
            ids = [c["base"], *c["tools"]]
            if len(set(ids)) != len(ids):
                errors.append(f"commands[{i}]: the same object appears twice in base/tools")
            for role, oid in [("base", c["base"]), *[(f"tools[{k}]", x) for k, x in enumerate(c["tools"])]]:
                if exists(i, oid, role) and oid in parent:
                    errors.append(f"commands[{i}].{role}: '{oid}' is already inside boolean '{parent[oid]}'; use '{parent[oid]}' instead")
            new_id = c.get("id")
            if new_id is not None:
                if id_used(new_id):
                    errors.append(f"commands[{i}].id: id '{new_id}' is already used")
                kinds[new_id] = "boolean"
                bases[new_id] = c["base"]
                for oid in ids:
                    parent[oid] = new_id
        elif t == "set_params":
            if exists(i, c["target"], "target"):
                kind = kinds[c["target"]]
                allowed = set(PARAMS_MODELS[kind].model_fields) if kind in PARAMS_MODELS else set()
                bad = sorted(set(c["params"]) - allowed)
                if bad:
                    hint = ", ".join(sorted(allowed)) or "none (edit its child objects instead)"
                    errors.append(f"commands[{i}].params: {kind} '{c['target']}' has no parameter {', '.join(bad)} (allowed: {hint})")
        elif t in ("set_suppressed", "set_appearance"):
            exists(i, c["target"], "target")
        elif t == "shell":
            if exists(i, c["target"], "target") and kinds[c["target"]] not in ("box", "cylinder", "extrude"):
                errors.append(f"commands[{i}].target: shell only works on box, cylinder or extrude; '{c['target']}' is a {kinds[c['target']]}")
        elif t in ("pattern", "set_pattern"):
            src = c["pattern"]["source"]
            if t == "set_pattern" and exists(i, c["target"], "target") and kinds[c["target"]] != "pattern":
                errors.append(f"commands[{i}].target: '{c['target']}' is not a pattern")
            if t == "pattern" and exists(i, src, "pattern.source"):
                if src in parent:
                    errors.append(f"commands[{i}].pattern.source: '{src}' is already inside '{parent[src]}'; use '{parent[src]}' instead")
                new_id = c.get("id")
                if new_id is not None:
                    if id_used(new_id):
                        errors.append(f"commands[{i}].id: id '{new_id}' is already used")
                    kinds[new_id] = "pattern"
                    bases[new_id] = src
                    parent[src] = new_id
        elif t == "hole":
            if exists(i, c["target"], "target"):
                if c["target"] in parent:
                    errors.append(f"commands[{i}].target: '{c['target']}' is inside '{parent[c['target']]}'; drill the parent instead")
                elif c["face"] not in (faces := allowed_faces(c["target"])):
                    errors.append(f"commands[{i}].face: '{c['target']}' has no face '{c['face']}' (faces: {', '.join(faces) or 'none'})")
            if c.get("id") is not None:
                if id_used(c["id"]):
                    errors.append(f"commands[{i}].id: id '{c['id']}' is already used")
                kinds[c["id"]] = "hole"
        elif t in ("edge_feature", "draft"):
            # 정밀 피처: 최상위 객체를 감싼다 (패턴과 같은 규칙)
            src = c["target"]
            if exists(i, src, "target"):
                if src in parent:
                    errors.append(f"commands[{i}].target: '{src}' is already inside '{parent[src]}'; use '{parent[src]}' instead")
                new_id = c.get("id")
                if new_id is not None:
                    if id_used(new_id):
                        errors.append(f"commands[{i}].id: id '{new_id}' is already used")
                    kinds[new_id] = "fillet" if t == "edge_feature" else "draft"
                    parent[src] = new_id
        elif t in ("set_edge_feature", "set_draft"):
            want = "fillet" if t == "set_edge_feature" else "draft"
            if exists(i, c["target"], "target") and kinds[c["target"]] != want:
                errors.append(f"commands[{i}].target: '{c['target']}' is not a {'fillet/chamfer' if want == 'fillet' else 'draft'} feature")
        elif t == "import_step":
            if c.get("id") is not None:
                if id_used(c["id"]):
                    errors.append(f"commands[{i}].id: id '{c['id']}' is already used")
                kinds[c["id"]] = "step"
        elif t in ("fillet", "chamfer"):
            if exists(i, c["target"], "target") and kinds[c["target"]] != "box":
                errors.append(f"commands[{i}].target: fillet/chamfer only works on boxes; '{c['target']}' is a {kinds[c['target']]}")
        elif t == "delete_object":
            if exists(i, c["target"], "target"):
                if c["target"] in parent:
                    errors.append(f"commands[{i}].target: '{c['target']}' is inside boolean '{parent[c['target']]}' and cannot be deleted alone")
                # 불리언 삭제 = 하위 트리 전체 삭제 (프론트엔드 실행기와 같은 규칙)
                gone = {c["target"]}
                while extra := {k for k, p in parent.items() if p in gone and k not in gone}:
                    gone |= extra
                if held := sorted(sk for sk, obj in anchors.items() if obj in gone):
                    errors.append(f"commands[{i}].target: sketch {', '.join(held)} is attached to a face of '{c['target']}'; "
                                  "delete or move those sketches first")
                for oid in gone:
                    kinds.pop(oid, None)
                    extrude_refs.pop(oid, None)
                    parent.pop(oid, None)
        elif t == "duplicate_object":
            if exists(i, c["target"], "target") and c.get("newId"):
                if id_used(c["newId"]):
                    errors.append(f"commands[{i}].newId: id '{c['newId']}' is already used")
                kinds[c["newId"]] = kinds[c["target"]]
        else:  # translate, set_transform, rename_object
            exists(i, c["target"], "target")

    return (commands if not errors else []), errors
