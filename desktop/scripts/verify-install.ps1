# NSIS 설치 프로그램을 조용히 설치하고, 설치된 앱을 실행해 로컬 엔진이 응답하는지 확인한다 (CI 용).
# 성공 기준: 엔진 기록에 주소가 찍히고 /api/health 200, 기준 판 계산 ok, 앱 종료 후 엔진 프로세스가 남지 않음.
$ErrorActionPreference = "Stop"
$root = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$logs = Join-Path $root "verify-logs"
New-Item -ItemType Directory -Force -Path $logs | Out-Null

$installer = Get-ChildItem "$root/desktop/src-tauri/target/release/bundle/nsis/*-setup.exe" | Select-Object -First 1
if (-not $installer) { throw "NSIS 설치 파일이 없습니다" }
Write-Host "설치: $($installer.Name) ($([math]::Round($installer.Length / 1MB)) MB)"
$p = Start-Process -FilePath $installer.FullName -ArgumentList "/S" -Wait -PassThru
if ($p.ExitCode -ne 0) { throw "설치 실패 (코드 $($p.ExitCode))" }

$exe = Get-ChildItem "$env:LOCALAPPDATA\AI 3D Studio\*.exe", "$env:ProgramFiles\AI 3D Studio\*.exe" -ErrorAction SilentlyContinue |
  Where-Object { $_.Name -notmatch "uninstall" } | Select-Object -First 1
if (-not $exe) { throw "설치된 앱을 찾지 못했습니다" }
Write-Host "실행: $($exe.FullName)"

$engineLog = Join-Path $env:APPDATA "com.ai3dstudio.desktop\logs\engine.log"
$engineLogAlt = Join-Path $env:LOCALAPPDATA "com.ai3dstudio.desktop\logs\engine.log"
Remove-Item $engineLog, $engineLogAlt -ErrorAction SilentlyContinue
$app = Start-Process -FilePath $exe.FullName -PassThru

try {
  $url = $null
  $deadline = (Get-Date).AddSeconds(180)
  while (-not $url -and (Get-Date) -lt $deadline) {
    Start-Sleep -Seconds 2
    foreach ($f in @($engineLog, $engineLogAlt)) {
      if (Test-Path $f) {
        $m = Select-String -Path $f -Pattern "http://127\.0\.0\.1:\d+/" | Select-Object -First 1
        if ($m) { $url = $m.Matches[0].Value }
      }
    }
    if ($app.HasExited) { throw "앱이 바로 종료되었습니다 (코드 $($app.ExitCode))" }
  }
  if (-not $url) { throw "엔진 주소가 기록되지 않았습니다 (180초)" }
  Write-Host "엔진: $url"

  # 엔진은 서버가 포트를 열기 전에 주소를 먼저 기록한다 → 응답할 때까지 기다린다 (셸도 같은 방식)
  $health = $null
  $deadline = (Get-Date).AddSeconds(120)
  while (-not $health -and (Get-Date) -lt $deadline) {
    try { $health = Invoke-RestMethod -Uri "${url}api/health" -TimeoutSec 5 } catch { Start-Sleep -Seconds 1 }
    if ($app.HasExited) { throw "앱이 종료되었습니다 (코드 $($app.ExitCode))" }
  }
  if (-not $health) { throw "엔진이 120초 안에 응답하지 않았습니다" }
  Write-Host "상태: $($health | ConvertTo-Json -Compress)"
  $model = Get-Content -Raw -Encoding utf8 "$root/shared/schemas/examples/model-sketch-plate.json"
  $r = Invoke-RestMethod -Uri "${url}api/model/evaluate" -Method Post -ContentType "application/json" -Body ([Text.Encoding]::UTF8.GetBytes($model)) -TimeoutSec 180
  if (-not $r.ok) { throw "계산 실패: $($r.issues | ConvertTo-Json -Compress)" }
  Write-Host "계산 ✓ $($r.meshes[0].objectId), 삼각형 $($r.meshes[0].triangleCount)"
  $page = Invoke-WebRequest -Uri $url -UseBasicParsing -TimeoutSec 10
  if ($page.Content -notmatch 'id="root"') { throw "화면(프론트엔드)이 제공되지 않습니다" }
  Write-Host "화면 ✓"
}
finally {
  foreach ($f in @($engineLog, $engineLogAlt)) { if (Test-Path $f) { Copy-Item $f $logs } }
  if (-not $app.HasExited) { Stop-Process -Id $app.Id -Force }
}

# 앱(부모)이 사라지면 엔진은 --parent-pid 감시로 스스로 종료되어야 한다
Start-Sleep -Seconds 8
$left = Get-Process -Name "ai3d-engine" -ErrorAction SilentlyContinue
if ($left) { $left | Format-Table Id, ProcessName, StartTime | Out-String | Write-Host; throw "앱 종료 후에도 엔진 프로세스가 남아 있습니다" }
Write-Host "앱 종료 → 엔진 종료 ✓"
