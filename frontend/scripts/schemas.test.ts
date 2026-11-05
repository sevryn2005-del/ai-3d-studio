/**
 * 계약 테스트: shared/schemas 에 커밋된 JSON Schema 가 현재 Zod 정의와 일치하는지 확인한다.
 * 실패하면 `npm run schema:export` 를 실행해 다시 생성하고 함께 커밋할 것.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CadCommandSchema } from '../src/cad/commandTypes';
import { generateSchemas } from '../src/cad/schemaExport';
import { SCHEMA_DIR, readSamples } from './schemaPaths';

describe('shared/schemas 동기화', () => {
  for (const [file, expected] of Object.entries(generateSchemas(readSamples()))) {
    it(`${file} 가 최신 상태다`, () => {
      const actual = readFileSync(join(SCHEMA_DIR, file), 'utf8');
      expect(actual, `${file} 가 오래되었습니다. npm run schema:export 를 실행하세요.`).toBe(expected);
    });
  }

  it('명령 스키마에 모든 명령 type 이 포함된다', () => {
    const schema = JSON.parse(generateSchemas(readSamples())['cad-command.schema.json']!);
    expect(schema.oneOf).toBeDefined();
    const types = schema.oneOf.map((s: { properties: { type: { const: string } } }) => s.properties.type.const);
    expect(types).toEqual([
      'create_box',
      'create_cylinder',
      'create_sphere',
      'create_cone',
      'create_sketch',
      'add_rectangle',
      'add_circle',
      'set_dimension',
      'set_entity_center',
      'delete_sketch_entity',
      'set_sketch_plane',
      'add_polygon',
      'add_line',
      'add_path',
      'set_corner',
      'set_arc',
      'convert_to_polygon',
      'add_slot',
      'set_entity_angle',
      'offset_entity',
      'move_point',
      'add_constraint',
      'set_constraint',
      'delete_constraint',
      'rename_sketch',
      'delete_sketch',
      'extrude',
      'revolve',
      'helix',
      'loft',
      'sweep',
      'set_thin',
      'add_mate',
      'set_mate',
      'delete_mate',
      'insert_part',
      'import_mesh',
      'edge_feature',
      'set_edge_feature',
      'draft',
      'set_draft',
      'import_step',
      'cut',
      'union',
      'intersect',
      'set_params',
      'fillet',
      'chamfer',
      'translate',
      'set_transform',
      'rename_object',
      'duplicate_object',
      'delete_object',
      'set_suppressed',
      'set_appearance',
      'shell',
      'pattern',
      'set_pattern',
      'hole',
    ]);
  });
});

describe('공유 예제 픽스처 (프론트/백엔드 계약)', () => {
  const load = (f: string) => JSON.parse(readFileSync(join(SCHEMA_DIR, 'examples', f), 'utf8'));
  const valid: unknown[] = load('cad-commands.valid.json');
  const invalid: { reason: string; command: unknown }[] = load('cad-commands.invalid.json');

  it.each(valid.map((c) => [JSON.stringify(c), c]))('통과: %s', (_, cmd) => {
    expect(CadCommandSchema.safeParse(cmd).success).toBe(true);
  });

  it.each(invalid.map((c) => [c.reason, c.command]))('거부: %s', (_, cmd) => {
    expect(CadCommandSchema.safeParse(cmd).success).toBe(false);
  });
});
