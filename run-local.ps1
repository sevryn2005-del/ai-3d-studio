# AI 3D Studio 로컬 모드 실행 (Windows PowerShell)
# 클라우드 서버 없이 이 PC 에서만 실행됩니다: http://127.0.0.1:8765
# 필요: uv (https://docs.astral.sh/uv/), 처음 한 번 프론트엔드 빌드에 Node.js
# 실행:  powershell -ExecutionPolicy Bypass -File .\run-local.ps1
$ErrorActionPreference = "Stop"
Set-Location $PSScriptRoot

if (-not (Test-Path "frontend\dist\index.html")) {
    Write-Host "프론트엔드를 빌드합니다 (처음 한 번)..."
    Push-Location frontend
    npm install
    npm run build
    Pop-Location
}

Set-Location backend
uv sync --quiet
uv run python -m app.local @args
