import { describe, expect, it } from 'vitest';
import { createDefaultModel } from '../../cad/defaultModel';
import { executeCommand } from '../../cad/commandExecutor';
import { nameFromFileName, parseProject, serializeProject } from './projectFile';

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
