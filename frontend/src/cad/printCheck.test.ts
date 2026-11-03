import { describe, expect, it } from 'vitest';
import { executeCommand } from './commandExecutor';
import { emptyModel, type ModelDefinition, type ObjectId, type Vec3 } from './commandTypes';
import { checkPrintability, dropToBedCommand, type WorldBox } from './printCheck';

function build(...cmds: unknown[]): ModelDefinition {
  let m = emptyModel();
  for (const c of cmds) {
    const r = executeCommand(m, c);
    if (!r.ok) throw new Error(r.error);
    m = r.model;
  }
  return m;
}
const box = (min: Vec3, max: Vec3): WorldBox => ({ min, max });
const boxes = (entries: [ObjectId, WorldBox][]) => new Map(entries);

describe('checkPrintability', () => {
  const one = build({ type: 'create_box', id: 'a', name: '받침', width: 20, depth: 20, height: 20 });

  it('바닥에 놓인 정상 객체는 문제 없음', () => {
    expect(checkPrintability(one, boxes([['a', box([-10, -10, 0], [10, 10, 20])]]))).toEqual([]);
  });

  it('바닥 아래로 내려가면 오류 + 바닥에 놓기 수정 명령', () => {
    const [issue] = checkPrintability(one, boxes([['a', box([-10, -10, -3.2], [10, 10, 16.8])]]));
    expect(issue).toMatchObject({
      severity: 'error', objectId: 'a', message: "'받침'이(가) 바닥 아래로 3.2mm 내려가 있습니다",
      fix: { label: '바닥에 놓기', command: { type: 'translate', target: 'a', offset: [0, 0, 3.2] } },
    });
  });

  it('떠 있으면 경고, 다른 객체 위에 얹혀 있으면 괜찮음', () => {
    const two = build(
      { type: 'create_box', id: 'a', width: 20, depth: 20, height: 20 },
      { type: 'create_box', id: 'b', width: 10, depth: 10, height: 10 },
    );
    const floating = checkPrintability(two, boxes([['a', box([-10, -10, 0], [10, 10, 20])], ['b', box([30, -5, 5], [40, 5, 15])]]));
    expect(floating).toHaveLength(1);
    expect(floating[0]).toMatchObject({ severity: 'warning', objectId: 'b', fix: { command: { offset: [0, 0, -5] } } });
    const stacked = checkPrintability(two, boxes([['a', box([-10, -10, 0], [10, 10, 20])], ['b', box([-5, -5, 20], [5, 5, 30])]]));
    expect(stacked).toEqual([]);
  });

  it('출력 범위보다 크면 경고', () => {
    const big = build({ type: 'create_box', id: 'a', width: 300, depth: 20, height: 20 });
    const [issue] = checkPrintability(big, boxes([['a', box([-150, -10, 0], [150, 10, 20])]]));
    expect(issue).toMatchObject({ severity: 'warning', message: expect.stringContaining('출력 범위 220×220×250mm') });
  });

  it('0.8mm 보다 얇은 치수는 경고, 구멍을 뚫는 도구와 원뿔 꼭짓점은 제외', () => {
    const m = build(
      { type: 'create_box', id: 'wall', name: '벽', width: 30, depth: 0.5, height: 10 },
      { type: 'create_cylinder', id: 'pin', radius: 0.3, height: 20, position: [0, 0, -1] },
      { type: 'cut', id: 'c', base: 'wall', tools: ['pin'] },
      { type: 'create_cone', id: 'tip', radiusBottom: 5, radiusTop: 0, height: 10, position: [40, 0, 0] },
    );
    const issues = checkPrintability(m, boxes([['c', box([-15, -0.25, 0], [15, 0.25, 10])], ['tip', box([35, -5, 0], [45, 5, 10])]]));
    expect(issues.map((i) => i.key)).toEqual(['thin:wall:depth']);
    expect(issues[0]!.message).toBe("'벽'의 깊이 0.5mm 는 0.8mm 보다 얇아 출력되지 않을 수 있습니다");
  });
});

describe('겹침 (합치지 않은 두 객체가 파고듦 → 슬라이서 문제, docs/issue-survey.md 7-2)', () => {
  const two = build(
    { type: 'create_box', id: 'a', name: '판', width: 20, depth: 20, height: 20 },
    { type: 'create_box', id: 'b', name: '기둥', width: 10, depth: 10, height: 10 },
  );
  it('서로 파고들면 경고 + 합치기 수정 명령, 그대로 실행 가능', () => {
    const issues = checkPrintability(two, boxes([['a', box([-10, -10, 0], [10, 10, 20])], ['b', box([5, -5, 0], [15, 5, 10])]]));
    expect(issues).toEqual([
      expect.objectContaining({ key: 'overlap:a:b', severity: 'warning', fix: { label: '합치기', command: { type: 'union', base: 'a', tools: ['b'] } } }),
    ]);
    expect(executeCommand(two, issues[0]!.fix!.command).ok).toBe(true);
  });
  it('면이 맞닿기만 하면 경고 없음', () => {
    expect(checkPrintability(two, boxes([['a', box([-10, -10, 0], [10, 10, 20])], ['b', box([10, -5, 0], [20, 5, 10])]]))).toEqual([]);
  });
});

describe('dropToBedCommand', () => {
  it('이미 바닥이면 명령 없음', () => {
    const m = build({ type: 'create_box', id: 'a', width: 1, depth: 1, height: 1 });
    expect(dropToBedCommand(m.objects[0]!, box([0, 0, 0.001], [1, 1, 1]))).toBeNull();
  });
});
