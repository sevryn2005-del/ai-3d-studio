"""편집 메시 모디파이어 (형식 v22) — frontend/src/cad/polymeshModifiers.ts 와 같은 규칙·같은 점/면 순서.

세분 표면(캐트멀-클락), 미러, 배열, 두께, 매끈하게·면 줄이기(형식 v31). 서버 엔진은 모디파이어를 적용한 메시를 솔리드로 꿰맨다 (mesh_import.polymesh_solid).
"""

from __future__ import annotations

import math

V3 = tuple[float, float, float]


def _r6(v: float) -> float:
    # JS Math.round(v * 1e6) / 1e6 와 같게 (0.5 는 위로)
    return math.floor(v * 1e6 + 0.5) / 1e6 + 0.0


def _rv(p) -> V3:
    return (_r6(p[0]), _r6(p[1]), _r6(p[2]))


def _add(a, b) -> V3:
    return (a[0] + b[0], a[1] + b[1], a[2] + b[2])


def _mul(a, s: float) -> V3:
    return (a[0] * s, a[1] * s, a[2] * s)


def _ekey(a: int, b: int) -> tuple[int, int]:
    return (a, b) if a < b else (b, a)


def centroid(verts, idx) -> V3:
    c = (0.0, 0.0, 0.0)
    for i in idx:
        c = _add(c, verts[i])
    return _mul(c, 1 / max(1, len(idx)))


def face_normal(verts, f) -> V3:
    n = [0.0, 0.0, 0.0]
    for i in range(len(f)):
        a, b = verts[f[i]], verts[f[(i + 1) % len(f)]]
        n[0] += (a[1] - b[1]) * (a[2] + b[2])
        n[1] += (a[2] - b[2]) * (a[0] + b[0])
        n[2] += (a[0] - b[0]) * (a[1] + b[1])
    ln = math.hypot(*n)
    return (n[0] / ln, n[1] / ln, n[2] / ln) if ln > 1e-12 else (0.0, 0.0, 0.0)


def catmull_clark(verts, faces):
    V = len(verts)
    edge_idx: dict[tuple[int, int], int] = {}
    edge_list: list[tuple[int, int]] = []
    edge_faces: list[list[int]] = []
    for fi, f in enumerate(faces):
        for i, a in enumerate(f):
            b = f[(i + 1) % len(f)]
            k = _ekey(a, b)
            e = edge_idx.get(k)
            if e is None:
                e = len(edge_list)
                edge_idx[k] = e
                edge_list.append((a, b))
                edge_faces.append([])
            edge_faces[e].append(fi)
    E = len(edge_list)
    face_pts = [centroid(verts, f) for f in faces]
    edge_pts = []
    for e, (a, b) in enumerate(edge_list):
        fs = edge_faces[e]
        s = _add(verts[a], verts[b])
        edge_pts.append(_mul(_add(s, _add(face_pts[fs[0]], face_pts[fs[1]])), 0.25) if len(fs) == 2 else _mul(s, 0.5))
    v_faces: list[list[int]] = [[] for _ in verts]
    for fi, f in enumerate(faces):
        for v in f:
            v_faces[v].append(fi)
    v_edges: list[list[int]] = [[] for _ in verts]
    for e, (a, b) in enumerate(edge_list):
        v_edges[a].append(e)
        v_edges[b].append(e)
    vert_pts = []
    for v, p in enumerate(verts):
        es = v_edges[v]
        if not es:
            vert_pts.append(p)
            continue
        boundary = [e for e in es if len(edge_faces[e]) != 2]
        if boundary:
            if len(boundary) != 2:
                vert_pts.append(p)
                continue
            n1, n2 = (verts[b if a == v else a] for a, b in (edge_list[e] for e in boundary))
            vert_pts.append(_mul(_add(_add(n1, n2), _mul(p, 6)), 1 / 8))
            continue
        n = len(es)
        F = (0.0, 0.0, 0.0)
        for fi in v_faces[v]:
            F = _add(F, face_pts[fi])
        F = _mul(F, 1 / len(v_faces[v]))
        R = (0.0, 0.0, 0.0)
        for e in es:
            a, b = edge_list[e]
            R = _add(R, _mul(_add(verts[a], verts[b]), 0.5))
        R = _mul(R, 1 / n)
        vert_pts.append(_mul(_add(_add(F, _mul(R, 2)), _mul(p, n - 3)), 1 / n))
    new_faces = []
    for fi, f in enumerate(faces):
        k = len(f)
        for i in range(k):
            prev, cur, nxt = f[(i - 1) % k], f[i], f[(i + 1) % k]
            new_faces.append([cur, V + edge_idx[_ekey(cur, nxt)], V + E + fi, V + edge_idx[_ekey(prev, cur)]])
    return [_rv(p) for p in vert_pts + edge_pts + face_pts], new_faces


MERGE_TOL = 1e-4


def mirror(verts, faces, axis: str, merge: bool):
    ax = "xyz".index(axis)
    on = [merge and abs(p[ax]) <= MERGE_TOL for p in verts]
    out = []
    for p, o in zip(verts, on):
        q = list(p)
        if o:
            q[ax] = 0.0
        out.append(tuple(q))
    mapping = []
    for p, o in zip(verts, on):
        if o:
            mapping.append(len(mapping))
        else:
            q = list(p)
            q[ax] = -q[ax]
            mapping.append(len(out))
            out.append(tuple(q))
    keep = [f for f in faces if not (merge and all(on[v] for v in f))]
    return [_rv(p) for p in out], keep + [[mapping[v] for v in f][::-1] for f in keep]


def array(verts, faces, count: int, offset):
    out_v, out_f = [], []
    for k in range(count):
        base = len(out_v)
        out_v.extend(_rv(_add(p, _mul(offset, k))) for p in verts)
        out_f.extend([v + base for v in f] for f in faces)
    return out_v, out_f


def solidify(verts, faces, thickness: float):
    V = len(verts)
    normals = [(0.0, 0.0, 0.0)] * V
    for f in faces:
        n = face_normal(verts, f)
        for v in f:
            normals[v] = _add(normals[v], n)
    inner = []
    for p, n in zip(verts, normals):
        ln = math.hypot(*n)
        inner.append(_add(p, _mul(n, -thickness / ln)) if ln > 1e-12 else p)
    count: dict[tuple[int, int], int] = {}
    for f in faces:
        for i, a in enumerate(f):
            k = _ekey(a, f[(i + 1) % len(f)])
            count[k] = count.get(k, 0) + 1
    out_f = [list(f) for f in faces] + [[v + V for v in f][::-1] for f in faces]
    for f in faces:
        for i, a in enumerate(f):
            b = f[(i + 1) % len(f)]
            if count[_ekey(a, b)] == 1:
                out_f.append([b, a, a + V, b + V])
    return [_rv(p) for p in list(verts) + inner], out_f


def _neighbors(verts, faces) -> list[list[int]]:
    """점마다 이웃 (면을 돌며 처음 만난 순서) — 프론트 neighbors 와 같은 순서"""
    out: list[list[int]] = [[] for _ in verts]
    for f in faces:
        for i, a in enumerate(f):
            b = f[(i + 1) % len(f)]
            if b not in out[a]:
                out[a].append(b)
            if a not in out[b]:
                out[b].append(a)
    return out


def smooth(verts, faces, factor: float, repeat: int):
    nb = _neighbors(verts, faces)
    vs = list(verts)
    for _ in range(repeat):
        cur = vs
        vs = []
        for i, p in enumerate(cur):
            ns = nb[i]
            if not ns:
                vs.append(p)
                continue
            c = (0.0, 0.0, 0.0)
            for j in ns:
                c = _add(c, cur[j])
            c = _mul(c, 1 / len(ns))
            vs.append(_rv(_add(p, _mul((c[0] - p[0], c[1] - p[1], c[2] - p[2]), factor))))
    return vs, [list(f) for f in faces]


def _sub(a, b) -> V3:
    return (a[0] - b[0], a[1] - b[1], a[2] - b[2])


def _cross(a, b) -> V3:
    return (a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0])


def _dot(a, b) -> float:
    return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]


def decimate(verts, faces, ratio: float):
    """면 줄이기 (짧은 선 합치기) — 프론트 decimateMesh 와 같은 차례·같은 검사"""
    pos = list(verts)
    tris = [[f[0], f[i], f[i + 1]] for f in faces for i in range(1, len(f) - 1)]
    target = max(4, math.floor(len(tris) * ratio + 0.5))
    for _ in range(100):
        if len(tris) <= target:
            break
        edge_count: dict[tuple[int, int], int] = {}
        nb: dict[int, set[int]] = {}
        vt: dict[int, list[int]] = {}
        edges: list[tuple[float, int, int]] = []
        for ti, t in enumerate(tris):
            for k in range(3):
                a, b = t[k], t[(k + 1) % 3]
                key = _ekey(a, b)
                c = edge_count.get(key, 0)
                edge_count[key] = c + 1
                if not c:
                    d = _sub(pos[key[0]], pos[key[1]])
                    edges.append((_dot(d, d), key[0], key[1]))
                nb.setdefault(a, set()).add(b)
                nb.setdefault(b, set()).add(a)
                vt.setdefault(a, []).append(ti)
        boundary = {v for key, c in edge_count.items() if c != 2 for v in key}
        edges.sort()
        locked: set[int] = set()
        dead: set[int] = set()
        alive = len(tris)
        for _l, a, b in edges:
            if alive <= target:
                break
            if a in locked or b in locked or a in boundary or b in boundary:
                continue
            na, nbb = nb[a], nb[b]
            if len(na & nbb) != 2:
                continue
            mid = _rv(_mul(_add(pos[a], pos[b]), 0.5))
            flips = False
            for ti in vt[a] + vt[b]:
                t = tris[ti]
                if a in t and b in t:
                    continue
                p = [pos[v] for v in t]
                q = [mid if v in (a, b) else pos[v] for v in t]
                if _dot(_cross(_sub(p[1], p[0]), _sub(p[2], p[0])), _cross(_sub(q[1], q[0]), _sub(q[2], q[0]))) <= 0:
                    flips = True
                    break
            if flips:
                continue
            pos[a] = mid
            for ti in vt[b]:
                t = tris[ti]
                if a in t:
                    dead.add(ti)
                else:
                    tris[ti] = [a if v == b else v for v in t]
            alive -= 2
            locked.update((a, b), na, nbb)
        if not dead:
            break
        tris = [t for ti, t in enumerate(tris) if ti not in dead]
    used = sorted({v for t in tris for v in t})
    index = {v: i for i, v in enumerate(used)}
    return [pos[v] for v in used], [[index[v] for v in t] for t in tris]


def evaluate(verts, faces, modifiers) -> tuple[list[V3], list[list[int]]]:
    """모디파이어 스택 결과 (위에서부터 차례로). modifiers: Pydantic 모델 또는 dict"""
    vs = [tuple(p) for p in verts]
    fs = [list(f) for f in faces]
    for m in modifiers or []:
        d = m if isinstance(m, dict) else m.model_dump()
        t = d["type"]
        if t == "subsurf":
            for _ in range(d["levels"]):
                vs, fs = catmull_clark(vs, fs)
        elif t == "mirror":
            vs, fs = mirror(vs, fs, d["axis"], d["merge"])
        elif t == "array":
            vs, fs = array(vs, fs, d["count"], d["offset"])
        elif t == "solidify":
            vs, fs = solidify(vs, fs, d["thickness"])
        elif t == "smooth":
            vs, fs = smooth(vs, fs, d["factor"], d["repeat"])
        elif t == "decimate":
            vs, fs = decimate(vs, fs, d["ratio"])
    return vs, fs
