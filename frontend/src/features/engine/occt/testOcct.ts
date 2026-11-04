/** 테스트(Node)에서 OCCT WASM 을 한 번만 불러온다 (Node 에서는 글루 코드가 패키지 안의 WASM 파일을 직접 읽는다) */
import init from 'replicad-opencascadejs';
import type { OC } from './occtGeometry';

let loading: Promise<OC> | null = null;
export function loadTestOcct(): Promise<OC> {
  loading ??= init({ print: () => {}, printErr: () => {} });
  return loading;
}
