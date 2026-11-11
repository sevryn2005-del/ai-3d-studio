import { beforeEach, describe, expect, it } from 'vitest';
import { explainError, fieldLabel, isNoise } from './errorGuide';
import { useNoticeStore } from './noticeStore';

describe('오류 안내', () => {
  it('명령 값 검사 → 항목 이름 + 설계는 그대로', () => {
    const g = explainError('잘못된 명령 (params.width): 치수는 0.1mm 이상이어야 합니다');
    expect(g.title).toBe('치수는 0.1mm 이상이어야 합니다');
    expect(g.hint).toContain("'너비'");
    expect(g.hint).toContain('설계는 바뀌지 않았습니다');
    expect(fieldLabel('params.flangePX')).toBe('플랜지 +X 높이');
    expect(explainError('잘못된 명령 (size): Too big: expected number to be <=500').title).toBe('값이 너무 큽니다 (500 이하로 넣으세요)');
    expect(explainError('잘못된 명령 (count): Invalid input: expected int, received number').title).toBe('정수(소수점 없는 수)를 넣으세요');
  });
  it('서버 연결 → 경고(계속 가능), 형상 실패 → 실행 취소 동작, 구속 충돌 → 구속 목록', () => {
    expect(explainError('TypeError: Failed to fetch')).toMatchObject({ level: 'warn', title: '로컬 CAD 서버에 연결할 수 없습니다' });
    expect(explainError("'박스 1' 형상을 만들 수 없습니다").actions).toEqual(['undo']);
    expect(explainError("'박스 1': 모서리를 둥글게 할 수 없습니다 (크기를 줄여 보세요)").hint).toMatch(/반지름/);
    expect(explainError('구속을 동시에 만족할 수 없습니다 (서로 모순되거나 과하게 구속되었습니다)').actions).toContain('select-sketch-constraints');
    expect(explainError('메이트를 동시에 만족할 수 없습니다').hint).toMatch(/반대 방향/);
    expect(explainError('QuotaExceededError: The quota has been exceeded.')).toMatchObject({ actions: ['save-file'] });
    expect(explainError('편집하는 동안 다른 변경이 먼저 적용되어 이 편집을 반영하지 않았습니다').level).toBe('info');
  });
  it('모르는 오류는 원문 + 일반 안내, 소음은 거른다', () => {
    const g = explainError('무언가 이상합니다');
    expect(g.title).toBe('무언가 이상합니다');
    expect(g.hint).toMatch(/Ctrl\+Z/);
    expect(isNoise('ResizeObserver loop completed with undelivered notifications.')).toBe(true);
    expect(isNoise('형상을 만들 수 없습니다')).toBe(false);
  });
});

describe('알림 상자', () => {
  beforeEach(() => useNoticeStore.getState().clear());
  it('같은 오류는 한 상자에 횟수만, 최대 4개', () => {
    const { report } = useNoticeStore.getState();
    report('형상을 만들 수 없습니다');
    report('형상을 만들 수 없습니다');
    expect(useNoticeStore.getState().notices).toHaveLength(1);
    expect(useNoticeStore.getState().notices[0]!.count).toBe(2);
    for (let i = 0; i < 6; i++) report(`오류 ${i}`);
    expect(useNoticeStore.getState().notices).toHaveLength(4);
    report('ResizeObserver loop limit exceeded');
    expect(useNoticeStore.getState().notices.some((n) => n.raw.includes('ResizeObserver'))).toBe(false);
  });
});
