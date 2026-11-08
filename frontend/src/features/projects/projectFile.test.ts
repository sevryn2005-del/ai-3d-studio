import { describe, expect, it } from 'vitest';
import { createDefaultModel } from '../../cad/defaultModel';
import { executeCommand } from '../../cad/commandExecutor';
import { PROJECT_FORMAT_VERSION, nameFromFileName, parseProject, serializeProject } from './projectFile';
import { MODEL_SCHEMA_VERSION } from '../../cad/commandTypes';

describe('프로젝트 파일', () => {
  it('저장 → 불러오기 왕복 (불리언 트리 포함)', () => {
    let model = createDefaultModel();
    for (const cmd of [
      { type: 'create_cylinder', radius: 3, height: 30, position: [0, 0, -1] },
      { type: 'cut', base: 'box_1', tools: ['cylinder_1'] },
    ]) {
      const r = executeCommand(model, cmd);
      if (!r.ok) throw new Error(r.error);
      model = r.model;
    }
    const text = serializeProject('받침대', model, new Date('2026-11-03T00:00:00Z'));
    const r = parseProject(text);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.project.name).toBe('받침대');
      expect(r.project.model).toEqual(model);
      expect(r.project.savedAt).toBe('2026-11-03T00:00:00.000Z');
    }
  });

  it.each([
    ['not json', 'JSON 형식이 아닙니다'],
    ['{"hello": 1}', '프로젝트 파일이 아닙니다'],
    ['{"format":"ai3d-project","formatVersion":99}', '더 새로운 버전'],
    [
      JSON.stringify({ ...JSON.parse(serializeProject('x', createDefaultModel())), model: { schemaVersion: 1, units: 'mm', objects: [{ id: 'bad id' }] } }),
      '올바르지 않습니다',
    ],
  ])('잘못된 파일 거부: %s', (text, message) => {
    const r = parseProject(text);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain(message);
  });

  it('그래프 규칙 위반(없는 참조)도 거부한다', () => {
    const file = JSON.parse(serializeProject('x', createDefaultModel()));
    file.model.objects.push({
      id: 'cut_1', name: '빼기', kind: 'boolean',
      boolean: { operation: 'cut', base: 'box_1', tools: ['ghost'] },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    });
    const r = parseProject(JSON.stringify(file));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('존재하지 않는 객체');
  });

  it('파일 이름 → 프로젝트 이름', () => {
    expect(nameFromFileName('받침대.ai3d')).toBe('받침대');
    expect(nameFromFileName('a.AI3D.json')).toBe('a');
  });
});

// 커밋 e0ac5e7 의 코드가 실제로 만든 저장 파일 (shared/samples/README.md)
import legacyV1 from '../../../../shared/samples/project-v1-e0ac5e7.ai3d?raw';

const legacyV1Copy = String(legacyV1);

describe('구버전 프로젝트 샘플 (e0ac5e7)', () => {
  it('열기 → 다시 저장 → 다시 열기: 설계 원본이 그대로', () => {
    const first = parseProject(legacyV1);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.project.name).toBe('기준 판 v1');
    expect(first.project.model.objects.map((o) => o.id)).toEqual(['plate', 'hole', 'plate_holed', 'knob']);
    const again = parseProject(serializeProject(first.project.name, first.project.model));
    expect(again.ok && again.project.model).toEqual(first.project.model);
    // v1 → v2 마이그레이션: 객체는 그대로, 형식만 v2 (스케치 없음)
    const v1 = JSON.parse(legacyV1).model;
    expect(v1.schemaVersion).toBe(1);
    expect(first.project.model).toEqual({ ...v1, schemaVersion: MODEL_SCHEMA_VERSION, sketches: [] });
    expect(JSON.parse(serializeProject('x', first.project.model)).formatVersion).toBe(PROJECT_FORMAT_VERSION);
    expect(legacyV1).toBe(legacyV1Copy); // 열기는 원본 문자열을 바꾸지 않는다
  });
});

describe('형식 v1 → v2 마이그레이션 경계', () => {
  it('v1 이지만 모델이 손상된 파일은 마이그레이션 후에도 거부', () => {
    const bad = JSON.stringify({ ...JSON.parse(legacyV1), model: { schemaVersion: 1, units: 'mm', objects: [{ id: 'X' }] } });
    expect(parseProject(bad).ok).toBe(false);
  });
  it('v2 파일인데 스케치 참조가 깨졌으면 거부 (현재 작업 유지)', () => {
    const v2 = JSON.parse(serializeProject('판', { schemaVersion: 33, units: 'mm', sketches: [], objects: [] }));
    v2.model.objects.push({
      id: 'plate', name: '판', kind: 'extrude', params: { distance: 4 }, extrude: { sketch: 'sk1', profile: 'r1' },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    });
    const r = parseProject(JSON.stringify(v2));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('존재하지 않는 스케치');
  });
  it('현재보다 새 형식은 새 버전으로 안내', () => {
    const r = parseProject(`{"format":"ai3d-project","formatVersion":${PROJECT_FORMAT_VERSION + 1}}`);
    expect(!r.ok && r.error).toContain('더 새로운 버전');
  });
});

// 이 변경 단위의 코드가 만든 v2 저장 파일 (shared/samples/README.md)
import plateV2 from '../../../../shared/samples/project-v2-plate.ai3d?raw';

describe('v2 기준 판 샘플 (v2 → v3 마이그레이션)', () => {
  it('스케치·돌출·구멍이 그대로 읽히고, 다시 저장해도 같다', () => {
    const r = parseProject(plateV2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.project.model.sketches.map((s) => s.id)).toEqual(['sk_plate', 'sk_hole']);
    expect(r.project.model.objects.map((o) => [o.id, o.kind])).toEqual([['plate', 'extrude'], ['hole', 'extrude'], ['plate_holed', 'boolean']]);
    const v2 = JSON.parse(plateV2).model;
    // v2 → v3 → v4: 내용 그대로, 스케치마다 빈 구속 목록
    expect(r.project.model).toEqual({ ...v2, schemaVersion: MODEL_SCHEMA_VERSION, sketches: v2.sketches.map((s: object) => ({ ...s, constraints: [] })) });
    const again = parseProject(serializeProject(r.project.name, r.project.model));
    expect(again.ok && again.project.model).toEqual(r.project.model);
  });
});

describe('v8 → 최신 마이그레이션', () => {
  it('헬릭스가 든 v8 파일이 그대로 읽히고 최신 형식으로 저장된다', () => {
    let model = createDefaultModel();
    for (const c of [
      { type: 'create_sketch', id: 's', plane: { type: 'XZ', offset: 0 } },
      { type: 'add_rectangle', sketch: 's', id: 'r', center: [10, 0], width: 4, height: 2 },
      { type: 'helix', id: 'h', sketch: 's', profile: 'r', pitch: 5, turns: 3 },
    ]) {
      const r = executeCommand(model, c as never);
      if (!r.ok) throw new Error(r.error);
      model = r.model;
    }
    const v8 = JSON.parse(serializeProject('스프링', model));
    v8.formatVersion = 8;
    v8.model.schemaVersion = 8;
    const r = parseProject(JSON.stringify(v8));
    if (!r.ok) throw new Error(r.error);
    expect(r.project.model.schemaVersion).toBe(MODEL_SCHEMA_VERSION);
    expect(r.project.model.objects.some((o) => o.kind === 'helix')).toBe(true);
    expect(JSON.parse(serializeProject(r.project.name, r.project.model)).formatVersion).toBe(PROJECT_FORMAT_VERSION);
  });
});
