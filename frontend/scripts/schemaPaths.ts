import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

/** 저장소 루트의 shared/schemas 디렉터리 */
export const SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../shared/schemas');
