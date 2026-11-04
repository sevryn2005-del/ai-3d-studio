/**
 * 워커 안에서 OCCT WASM 을 처음 필요할 때 한 번만 불러온다 (gzip 압축본 occt-gzip.wasm → DecompressionStream).
 * 정밀 피처가 없는 모델은 이 모듈을 불러오지 않으므로 처음 화면이 무거워지지 않는다.
 */
import init from 'replicad-opencascadejs';
import gzUrl from './generated/occt-gzip.wasm?url';
import type { OC } from './occtGeometry';

let loading: Promise<OC> | null = null;

async function wasmBytes(): Promise<ArrayBuffer> {
  const res = await fetch(gzUrl);
  if (!res.ok || !res.body) throw new Error(`정밀 엔진 파일을 읽지 못했습니다 (${res.status})`);
  const raw = await res.arrayBuffer();
  const head = new Uint8Array(raw, 0, 2);
  // 서버가 이미 압축을 풀어 보냈으면(Content-Encoding) 그대로 WASM 이다
  if (head[0] !== 0x1f || head[1] !== 0x8b) return raw;
  return new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

export function loadOcct(): Promise<OC> {
  loading ??= wasmBytes()
    .then((wasmBinary) => init({ wasmBinary, print: () => {}, printErr: () => {} }))
    .catch((e) => {
      loading = null; // 다음 요청에서 다시 시도
      throw e;
    });
  return loading;
}
