import { describe, expect, it } from 'vitest';
import { executeCommand, findObject } from './commandExecutor';
import { paramsOf } from './testUtils';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { createDefaultModel } from './defaultModel';

function run(model: ModelDefinition, cmd: unknown): ModelDefinition {
  const r = executeCommand(model, cmd);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

describe('create_box', () => {
  it('지정한 치수(mm)로 박스를 만든다', () => {
    const m = run(emptyModel(), { type: 'create_box', width: 30, depth: 40, height: 50 });
    expect(m.objects).toHaveLength(1);
    expect(m.objects[0]).toMatchObject({
      id: 'box_1',
      kind: 'box',
      params: { width: 30, depth: 40, height: 50 },
      transform: { position: [0, 0, 0], rotation: [0, 0, 0] },
    });
  });

  it('ID를 자동으로 증가시킨다', () => {
    let m = run(emptyModel(), { type: 'create_box', width: 1, depth: 1, height: 1 });
    m = run(m, { type: 'create_box', width: 1, depth: 1, height: 1 });
    expect(m.objects.map((o) => o.id)).toEqual(['box_1', 'box_2']);
  });

  it('중복 ID는 거부한다', () => {
    const m = createDefaultModel();
    const r = executeCommand(m, { type: 'create_box', id: 'box_1', width: 1, depth: 1, height: 1 });
    expect(r.ok).toBe(false);
  });

  it.each([0, -5, 0.05, 1001, Number.NaN, Infinity])('범위를 벗어난 치수 %s 는 거부한다', (v) => {
    const r = executeCommand(emptyModel(), { type: 'create_box', width: v, depth: 10, height: 10 });
    expect(r.ok).toBe(false);
  });

  it('원본 모델을 변경하지 않는다 (불변성)', () => {
    const m = emptyModel();
    run(m, { type: 'create_box', width: 10, depth: 10, height: 10 });
    expect(m.objects).toHaveLength(0);
  });
});

describe('set_params — "높이를 50mm로 바꿔줘"', () => {
  it('지정한 파라미터만 변경한다', () => {
    const m = run(createDefaultModel(), { type: 'set_params', target: 'box_1', params: { height: 50 } });
    expect(paramsOf(findObject(m, 'box_1'))).toEqual({ width: 20, depth: 20, height: 50 });
  });

  it('존재하지 않는 객체는 거부한다', () => {
    const r = executeCommand(createDefaultModel(), { type: 'set_params', target: 'box_9', params: { height: 50 } });
    expect(r).toEqual({ ok: false, error: '존재하지 않는 객체입니다: box_9' });
  });

  it('빈 파라미터는 거부한다', () => {
    const r = executeCommand(createDefaultModel(), { type: 'set_params', target: 'box_1', params: {} });
    expect(r.ok).toBe(false);
  });
});

describe('변환 명령', () => {
  it('translate 는 상대 이동한다', () => {
    let m = run(createDefaultModel(), { type: 'translate', target: 'box_1', offset: [5, 0, 0] });
    m = run(m, { type: 'translate', target: 'box_1', offset: [5, -3, 1] });
    expect(findObject(m, 'box_1')?.transform.position).toEqual([10, -3, 1]);
  });

  it('set_transform 은 절대 위치/회전을 설정한다', () => {
    const m = run(createDefaultModel(), {
      type: 'set_transform',
      target: 'box_1',
      rotation: [0, 0, 45],
    });
    expect(findObject(m, 'box_1')?.transform).toEqual({ position: [0, 0, 0], rotation: [0, 0, 45] });
  });

  it('작업 영역 밖으로의 이동은 거부한다', () => {
    const r = executeCommand(createDefaultModel(), { type: 'translate', target: 'box_1', offset: [20000, 0, 0] });
    expect(r.ok).toBe(false);
  });
});

describe('복제 / 삭제 / 이름 변경', () => {
  it('duplicate_object 는 새 ID와 오프셋 위치로 복사한다', () => {
    const m = run(createDefaultModel(), { type: 'duplicate_object', target: 'box_1', offset: [30, 0, 0] });
    expect(m.objects).toHaveLength(2);
    expect(findObject(m, 'box_2')?.transform.position).toEqual([30, 0, 0]);
    expect(paramsOf(findObject(m, 'box_2'))).toEqual(paramsOf(findObject(m, 'box_1')));
  });

  it('delete_object 는 객체를 제거한다', () => {
    const m = run(createDefaultModel(), { type: 'delete_object', target: 'box_1' });
    expect(m.objects).toHaveLength(0);
  });

  it('rename_object 는 이름을 바꾼다', () => {
    const m = run(createDefaultModel(), { type: 'rename_object', target: 'box_1', name: '받침대' });
    expect(findObject(m, 'box_1')?.name).toBe('받침대');
  });
});

describe('보안: 알 수 없는 입력 거부', () => {
  it.each([
    null,
    'create_box',
    { type: 'exec_python', code: 'import os' },
    { type: 'create_box', width: '10', depth: 10, height: 10 },
    { type: 'set_params', target: '../etc', params: { height: 5 } },
  ])('%j', (input) => {
    expect(executeCommand(createDefaultModel(), input).ok).toBe(false);
  });
});

describe('도면 여러 장 (형식 v27)', () => {
  const d = (title: string) => ({ paper: 'A4' as const, scale: 'auto' as const, title, views: ['front' as const], dimensions: true, centerlines: true });
  it('1장째 = drawing, 시트 수와 같은 번호 = 새 시트, 건너뛴 번호는 거부, 지우면 앞으로 당겨짐', () => {
    let m = run(emptyModel(), { type: 'set_drawing', drawing: d('하나') });
    expect(m.drawing?.title).toBe('하나');
    m = run(m, { type: 'set_drawing', drawing: d('둘'), sheet: 1 });
    m = run(m, { type: 'set_drawing', drawing: d('셋'), sheet: 2 });
    expect(m.drawingSheets?.map((s) => s.title)).toEqual(['둘', '셋']);
    const skip = executeCommand(m, { type: 'set_drawing', drawing: d('다섯'), sheet: 4 });
    expect(skip.ok).toBe(false);
    m = run(m, { type: 'set_drawing', drawing: d('둘*'), sheet: 1 });
    expect(m.drawingSheets?.map((s) => s.title)).toEqual(['둘*', '셋']);
    m = run(m, { type: 'delete_drawing_sheet', sheet: 1 });
    expect(m.drawingSheets?.map((s) => s.title)).toEqual(['셋']);
    m = run(m, { type: 'delete_drawing_sheet', sheet: 1 });
    expect(m.drawingSheets).toBeUndefined();
    expect(executeCommand(m, { type: 'delete_drawing_sheet', sheet: 1 }).ok).toBe(false);
    expect(m.drawing?.title).toBe('하나');
  });

  it('최대 10장', () => {
    let m = emptyModel();
    for (let k = 1; k <= 9; k++) m = run(m, { type: 'set_drawing', drawing: d(`${k}`), sheet: k });
    expect(m.drawingSheets).toHaveLength(9);
    expect(executeCommand(m, { type: 'set_drawing', drawing: d('넘침'), sheet: 9 }).ok).toBe(true); // 9장째 바꾸기는 됨
  });
});
