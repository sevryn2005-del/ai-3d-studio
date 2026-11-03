import { describe, expect, it } from 'vitest';
import { executeCommand, findObject } from './commandExecutor';
import { createDefaultModel } from './defaultModel';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { validateGraph } from './modelGraph';
import { sizeSummary } from './objectKinds';
import { describeCommand } from './describeCommand';

function run(m: ModelDefinition, c: unknown) {
  const r = executeCommand(m, c);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}
const box = () => run(emptyModel(), { type: 'create_box', id: 'b', name: '함', width: 30, depth: 20, height: 10 });

describe('fillet / chamfer', () => {
  it('기본은 모든 모서리, 목록에 R2 표시', () => {
    const m = run(box(), { type: 'fillet', target: 'b', radius: 2 });
    expect(findObject(m, 'b')).toMatchObject({ edgeFeature: { type: 'fillet', size: 2, edges: 'all' } });
    expect(sizeSummary(findObject(m, 'b')!)).toBe('30×20×10 R2');
  });

  it('세로 모서리 모따기, 0 이면 제거', () => {
    let m = run(box(), { type: 'chamfer', target: 'b', distance: 3, edges: 'vertical' });
    expect(sizeSummary(findObject(m, 'b')!)).toBe('30×20×10 C3 세로');
    m = run(m, { type: 'chamfer', target: 'b', distance: 0 });
    expect(findObject(m, 'b')).not.toHaveProperty('edgeFeature');
  });

  it('크기 제한: 모든 모서리는 가장 짧은 변(높이 10)의 절반 미만, 세로는 너비·깊이 기준', () => {
    expect(executeCommand(box(), { type: 'fillet', target: 'b', radius: 5 })).toMatchObject({
      ok: false, error: '모서리 반지름 5mm 가 너무 큽니다 (5mm 보다 작아야 합니다)',
    });
    expect(executeCommand(box(), { type: 'fillet', target: 'b', radius: 8, edges: 'vertical' }).ok).toBe(true);
  });

  it('박스를 줄여서 모서리 처리가 안 들어가면 거부', () => {
    const m = run(box(), { type: 'fillet', target: 'b', radius: 4 });
    const r = executeCommand(m, { type: 'set_params', target: 'b', params: { height: 6 } });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain('모서리 처리를 먼저 줄이세요');
    expect(findObject(run(m, { type: 'set_params', target: 'b', params: { width: 40 } }), 'b')).toMatchObject({ edgeFeature: { size: 4 } });
  });

  it('박스가 아니면 거부', () => {
    const m = run(createDefaultModel(), { type: 'create_sphere', id: 's', radius: 5 });
    expect(executeCommand(m, { type: 'fillet', target: 's', radius: 1 })).toMatchObject({ ok: false });
  });

  it('불러온 파일의 잘못된 모서리 크기를 찾는다', () => {
    const m = run(box(), { type: 'fillet', target: 'b', radius: 2 });
    const bad = { ...m, objects: m.objects.map((o) => (o.kind === 'box' ? { ...o, edgeFeature: { ...o.edgeFeature!, size: 9 } } : o)) };
    expect(validateGraph(bad)[0]).toContain('너무 큽니다');
  });

  it('설명 문구', () => {
    expect(describeCommand({ type: 'fillet', target: 'b', radius: 2 }, box())).toBe('함 모든 모서리 둥글게 R2mm');
    expect(describeCommand({ type: 'chamfer', target: 'b', distance: 1, edges: 'vertical' }, box())).toBe('함 세로 모서리 모따기 1mm');
  });
});
