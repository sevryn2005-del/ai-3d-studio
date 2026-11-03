import { describe, expect, it } from 'vitest';
import { executeCommand, findObject } from './commandExecutor';
import { paramsOf } from './testUtils';
import { emptyModel, type ModelDefinition } from './commandTypes';
import { createDefaultModel } from './defaultModel';
import { localSize, sizeSummary } from './objectKinds';
import { nextFreePosition, PLACEMENT_GAP } from './placement';

function run(model: ModelDefinition, cmd: unknown): ModelDefinition {
  const r = executeCommand(model, cmd);
  if (!r.ok) throw new Error(r.error);
  return r.model;
}

describe('create_cylinder / create_sphere / create_cone', () => {
  it('원통을 만든다', () => {
    const m = run(emptyModel(), { type: 'create_cylinder', radius: 5, height: 30 });
    expect(m.objects[0]).toMatchObject({ id: 'cylinder_1', kind: 'cylinder', name: '원통 1', params: { radius: 5, height: 30 } });
  });

  it('구를 만든다', () => {
    const m = run(emptyModel(), { type: 'create_sphere', radius: 12.5, position: [10, 0, 0] });
    expect(m.objects[0]).toMatchObject({ id: 'sphere_1', params: { radius: 12.5 }, transform: { position: [10, 0, 0] } });
  });

  it('꼭짓점이 뾰족한 원뿔(위 반지름 0)을 허용한다', () => {
    const m = run(emptyModel(), { type: 'create_cone', radiusBottom: 10, radiusTop: 0, height: 20 });
    expect(paramsOf(findObject(m, 'cone_1'))).toEqual({ radiusBottom: 10, radiusTop: 0, height: 20 });
  });

  it('위·아래 반지름이 모두 0인 원뿔은 거부한다', () => {
    const r = executeCommand(emptyModel(), { type: 'create_cone', radiusBottom: 0, radiusTop: 0, height: 20 });
    expect(r.ok).toBe(false);
  });

  it.each([
    { type: 'create_cylinder', radius: 0, height: 10 },
    { type: 'create_cylinder', radius: 501, height: 10 },
    { type: 'create_sphere', radius: -1 },
    { type: 'create_sphere' },
    { type: 'create_sphere', radius: 5, width: 10 }, // 알 수 없는 필드
  ])('잘못된 생성 명령 거부: %j', (cmd) => {
    expect(executeCommand(emptyModel(), cmd).ok).toBe(false);
  });

  it('도형 종류별로 ID 번호를 따로 매긴다', () => {
    let m = run(createDefaultModel(), { type: 'create_cylinder', radius: 5, height: 5 });
    m = run(m, { type: 'create_box', width: 5, depth: 5, height: 5 });
    expect(m.objects.map((o) => o.id)).toEqual(['box_1', 'cylinder_1', 'box_2']);
  });
});

describe('set_params — 도형 종류별 검증', () => {
  const withCylinder = () => run(emptyModel(), { type: 'create_cylinder', id: 'pin', radius: 5, height: 30 });

  it('원통의 반지름을 바꾼다', () => {
    const m = run(withCylinder(), { type: 'set_params', target: 'pin', params: { radius: 8 } });
    expect(paramsOf(findObject(m, 'pin'))).toEqual({ radius: 8, height: 30 });
  });

  it('원통에 width 를 지정하면 이유와 함께 거부한다', () => {
    const r = executeCommand(withCylinder(), { type: 'set_params', target: 'pin', params: { width: 10 } });
    expect(r).toEqual({ ok: false, error: '원통에는 width 파라미터가 없습니다 (사용 가능: radius, height)' });
  });

  it('원뿔 수정 후에도 교차 규칙(반지름 하나는 0 초과)을 검사한다', () => {
    const m = run(emptyModel(), { type: 'create_cone', radiusBottom: 10, radiusTop: 0, height: 20 });
    const r = executeCommand(m, { type: 'set_params', target: 'cone_1', params: { radiusBottom: 0 } });
    expect(r.ok).toBe(false);
  });

  it('스키마에 없는 파라미터 이름은 거부한다', () => {
    const r = executeCommand(createDefaultModel(), { type: 'set_params', target: 'box_1', params: { thickness: 2 } });
    expect(r.ok).toBe(false);
  });
});

describe('objectKinds', () => {
  it('크기 요약과 로컬 크기', () => {
    const m = run(emptyModel(), { type: 'create_cone', radiusBottom: 10, radiusTop: 4, height: 20 });
    const cone = m.objects[0]!;
    expect(sizeSummary(cone)).toBe('Ø20→Ø8×20');
    expect(localSize(cone, m)).toEqual([20, 20, 20]);
  });
});

describe('nextFreePosition', () => {
  it('빈 모델은 원점', () => {
    expect(nextFreePosition(emptyModel(), 20)).toEqual([0, 0, 0]);
  });
  it('기존 객체 오른쪽에 간격을 두고 배치한다', () => {
    // 20×20 박스(원점) → 대각선 반경 ≈ 14.14 → 14.14 + 10 + 10 → 35 (올림)
    const [x] = nextFreePosition(createDefaultModel(), 20);
    expect(x).toBe(Math.ceil(Math.hypot(20, 20) / 2 + PLACEMENT_GAP + 10));
  });
});
