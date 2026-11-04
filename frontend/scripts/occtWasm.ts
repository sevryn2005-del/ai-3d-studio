/**
 * 브라우저 정밀 엔진(OCCT)의 WASM(약 23MB)을 gzip(약 7MB)으로 미리 압축한다.
 * 웹 정적 배포는 파일 하나의 크기 제한이 있고 서버가 압축해 준다는 보장이 없으므로, 압축본을 번들에 넣고
 * 워커가 DecompressionStream 으로 푼다 (occt/loadOcct.ts). 외부 CDN 을 쓰지 않는다 (CLAUDE.md 1장 6).
 */
import { createRequire } from 'node:module';
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import type { Plugin } from 'vite';

export const OCCT_WASM_GZ = resolve(dirname(fileURLToPath(import.meta.url)), '../src/features/engine/occt/generated/occt-wasm.gz');

export function ensureOcctWasmGz(): string {
  const src = createRequire(import.meta.url).resolve('replicad-opencascadejs/wasm');
  if (!existsSync(OCCT_WASM_GZ) || statSync(OCCT_WASM_GZ).mtimeMs < statSync(src).mtimeMs) {
    mkdirSync(dirname(OCCT_WASM_GZ), { recursive: true });
    writeFileSync(OCCT_WASM_GZ, gzipSync(readFileSync(src), { level: 9 }));
  }
  return OCCT_WASM_GZ;
}

/** Vite 플러그인: 압축본 준비 + OCCT 글루 코드가 원본 WASM(23MB)을 자산으로 끌어들이지 않게 막는다 (항상 wasmBinary 로 넘김) */
export function occtWasmPlugin(): Plugin {
  return {
    name: 'occt-wasm-gz',
    buildStart() {
      ensureOcctWasmGz();
    },
    transform(code, id) {
      if (!/replicad-opencascadejs[\\/]dist[\\/]replicad_single\.js$/.test(id)) return null;
      return { code: code.replace('new URL("replicad_single.wasm",import.meta.url)', '""'), map: null };
    },
  };
}
