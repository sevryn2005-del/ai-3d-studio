# PyInstaller 설정: 로컬 모드 엔진(API + CAD 워커 + 프론트엔드)을 폴더 하나로 묶는다.
#   cd backend && uv run --group packaging pyinstaller packaging/ai3d-engine.spec --noconfirm
# 결과: backend/dist/ai3d-engine/ (ai3d-engine[.exe] + _internal/)
# 먼저 frontend 를 빌드해야 한다 (frontend/dist → 묶음의 web/).
# LGPL 라이브러리(OCCT 등)는 별도 DLL/공유 라이브러리로 그대로 둔다 (--onefile·정적 링크 아님).
import os
from PyInstaller.utils.hooks import collect_all, collect_submodules

import sys

ROOT = os.path.abspath(os.path.join(SPECPATH, "..", ".."))
BACKEND = os.path.join(ROOT, "backend")
sys.path.insert(0, BACKEND)  # collect_submodules("app") 가 앱 패키지를 찾도록
WEB = os.path.join(ROOT, "frontend", "dist")
if not os.path.exists(os.path.join(WEB, "index.html")):
    raise SystemExit("frontend/dist 가 없습니다. 먼저 cd frontend && npm run build")

datas = [
    (WEB, "web"),
    (os.path.join(ROOT, "shared", "schemas", "cad-command.schema.json"), os.path.join("shared", "schemas")),
    (os.path.join(ROOT, "THIRD_PARTY_NOTICES.md"), "."),
    (os.path.join(ROOT, "licenses"), "licenses"),
]
binaries = []
# app.cad.jobs 는 워커가 문자열로 import 하므로 정적 분석에 잡히지 않는다 → 명시
hiddenimports = collect_submodules("app") + collect_submodules("uvicorn") + ["app.cad.jobs"]
if "app.cad.jobs" not in collect_submodules("app"):
    raise SystemExit("app 패키지를 찾지 못했습니다 (collect_submodules)")
for pkg in ("cadquery", "OCP", "casadi", "anthropic"):
    d, b, h = collect_all(pkg)
    datas += d
    binaries += b
    hiddenimports += h

a = Analysis(
    [os.path.join(SPECPATH, "desktop_entry.py")],
    pathex=[BACKEND],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    excludes=["tkinter", "pytest", "IPython", "matplotlib"],
    noarchive=False,
)
pyz = PYZ(a.pure)
exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="ai3d-engine",
    console=True,  # 데스크톱 앱이 창 없이(CREATE_NO_WINDOW) 실행한다. 단독 실행 시 로그가 보이도록 콘솔 유지
    upx=False,
)
coll = COLLECT(exe, a.binaries, a.datas, name="ai3d-engine", upx=False)
