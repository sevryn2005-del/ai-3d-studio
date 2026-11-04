/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { occtWasmPlugin } from './scripts/occtWasm';

export default defineConfig({
  plugins: [react(), occtWasmPlugin()],
  // CAD 워커(정밀 엔진 포함)는 별도로 번들되므로 같은 플러그인을 워커에도 건다
  worker: { format: 'es', plugins: () => [occtWasmPlugin()] },
  server: {
    port: 5173,
    // 2주 차: FastAPI 백엔드(8000)로 /api 요청을 프록시한다.
    proxy: { '/api': 'http://localhost:8000' },
  },
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts', 'scripts/**/*.test.ts'],
  },
});
