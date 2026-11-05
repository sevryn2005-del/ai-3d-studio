import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { defineConfig } from '@playwright/test';

/**
 * E2E 테스트: 실제 브라우저에서 편집기를 조작한다.
 * 처음 한 번 `npx playwright install chromium` 필요.
 * 이미 설치된 Chromium 을 쓰려면 PW_CHROMIUM_PATH 환경 변수로 경로를 지정한다.
 */
export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: false,
  use: {
    // E2E_BASE_URL=http://127.0.0.1:8765 으로 로컬 모드(빌드본)를 대상으로 실행할 수 있다
    baseURL: process.env.E2E_BASE_URL || 'http://localhost:5174',
    viewport: { width: 1440, height: 860 },
    // 기존 테스트는 시작 화면을 건너뛰고 예전 통합 화면(큐브 하나)에서 시작한다. 시작 화면 자체는 home.spec.ts 가 검사
    storageState: 'e2e/skip-home.json',
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    launchOptions: {
      executablePath: process.env.PW_CHROMIUM_PATH || undefined,
      // GPU 없는 CI 환경에서도 WebGL 이 동작하도록 소프트웨어 렌더러 사용
      args: ['--use-gl=angle', '--use-angle=swiftshader'],
      // 로케일이 없는(ASCII) 리눅스 CI 에서는 Chromium 이 한글 다운로드 파일명을 "download" 로 바꾼다.
      // 실제 사용자 환경(UTF-8 / Windows)과 같게 UTF-8 로케일을 지정한다.
      env: { ...process.env, LANG: process.env.LANG || 'C.UTF-8' },
    },
  },
  webServer: [
    {
      // 백엔드 (FastAPI). uv 필요: https://docs.astral.sh/uv/
      command: 'uv run uvicorn app.main:app --port 8000',
      cwd: '../backend',
      // E2E 가 사용자의 실제 AI 설정·사용량 파일을 건드리지 않도록 임시 데이터 폴더, API 키는 비움
      env: { ...process.env, AI3D_DATA_DIR: join(tmpdir(), 'ai3d-e2e-data'), ANTHROPIC_API_KEY: '' },
      url: 'http://localhost:8000/api/health',
      reuseExistingServer: !process.env.CI,
    },
    {
      command: 'npx vite --port 5174 --strictPort',
      url: 'http://localhost:5174',
      reuseExistingServer: !process.env.CI,
    },
  ],
});
