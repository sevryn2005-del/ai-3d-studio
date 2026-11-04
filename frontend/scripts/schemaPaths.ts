import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** 저장소 루트의 shared/schemas 디렉터리 */
export const SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../shared/schemas');

/** 픽스처에 넣는 실제 샘플 파일 (shared/samples). STEP 은 CadQuery 로 만든 파일 */
export function readSamples() {
  return { blockHoleStep: readFileSync(resolve(SCHEMA_DIR, '../samples/block-hole.step')).toString('base64') };
}
