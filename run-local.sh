#!/usr/bin/env bash
# AI 3D Studio 로컬 모드 실행 (macOS / Linux)
# 클라우드 서버 없이 이 PC 에서만 실행됩니다: http://127.0.0.1:8765
# 필요: uv (https://docs.astral.sh/uv/), 처음 한 번 프론트엔드 빌드에 Node.js
set -euo pipefail
cd "$(dirname "$0")"

if [ ! -f frontend/dist/index.html ]; then
  echo "프론트엔드를 빌드합니다 (처음 한 번)..."
  (cd frontend && npm install && npm run build)
fi

cd backend
uv sync --quiet
exec uv run python -m app.local "$@"
