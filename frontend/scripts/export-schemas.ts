/** 사용법: npm run schema:export  →  shared/schemas/*.schema.json 갱신 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { generateSchemas } from '../src/cad/schemaExport';
import { SCHEMA_DIR } from './schemaPaths';

mkdirSync(SCHEMA_DIR, { recursive: true });
for (const [file, content] of Object.entries(generateSchemas())) {
  mkdirSync(dirname(join(SCHEMA_DIR, file)), { recursive: true });
  writeFileSync(join(SCHEMA_DIR, file), content);
  console.log(`✓ ${join(SCHEMA_DIR, file)}`);
}
