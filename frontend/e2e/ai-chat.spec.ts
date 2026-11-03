/**
 * AI 채팅 (실제 AI API 를 호출하지 않는다: /api/ai/* 응답을 테스트에서 대체).
 * - AI 호출은 사용자가 보낼 때만 (편집으로는 호출되지 않음)
 * - AI 변경 = 실행 취소 1단계
 * - 정보가 부족하면 질문 → 선택지로 답변
 */
import { expect, test, type Page, type Route } from '@playwright/test';

const SETTINGS = {
  enabled: true, model: 'claude-opus-5-5', keyConfigured: true, keySource: 'saved', keyHint: '…1234',
  models: [{ id: 'claude-opus-5-5', label: 'Claude Opus 5.5 (권장)', price: { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 } }],
};
const ZERO = { requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
const usage = (costUsd: number) => ({
  time: '2026-11-03T00:00:00+00:00', model: 'claude-opus-5-5', kind: 'commands', requests: 1,
  inputTokens: 3000, outputTokens: 200, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd,
});

async function mockAi(page: Page, replies: object[]) {
  const requests: { message: string; history: { role: string; text: string }[]; selectedId: string | null }[] = [];
  await page.route('**/api/ai/settings', (r) => r.fulfill({ json: SETTINGS }));
  await page.route('**/api/ai/usage', (r) => r.fulfill({ json: { today: ZERO, month: ZERO, all: ZERO, recent: [] } }));
  await page.route('**/api/ai/chat', async (route: Route) => {
    requests.push(route.request().postDataJSON());
    const reply = replies.shift();
    if (!reply) return route.fulfill({ status: 500, body: 'unexpected' });
    await route.fulfill({ json: { commands: [], options: [], issues: [], ...reply } });
  });
  return requests;
}

async function say(page: Page, text: string) {
  const box = page.getByLabel('AI 에게 보낼 메시지');
  await box.fill(text);
  await box.press('Enter');
}

test('"높이를 50mm로 바꿔줘" → 실제 모델 변경, 실행 취소 1번, 호출은 보낼 때만', async ({ page }) => {
  const requests = await mockAi(page, [
    {
      kind: 'commands', message: '높이를 50mm로 바꿨습니다.',
      commands: [{ type: 'set_params', target: 'box_1', params: { height: 50 } }],
      usage: usage(0.0162), month: { requests: 1, inputTokens: 3000, outputTokens: 200, costUsd: 0.0162 },
    },
  ]);
  await page.goto('/');
  await expect(page.getByTestId('ai-status')).toHaveText('Claude Opus 5.5');

  // 직접 편집은 AI 를 부르지 않는다
  await page.getByRole('button', { name: '+ 원통' }).click();
  await page.keyboard.press('Control+z');
  await page.locator('[data-object-id="box_1"]').click();
  expect(requests).toHaveLength(0);

  await say(page, '높이를 50mm로 바꿔줘');
  await expect(page.locator('.object-list')).toContainText('20×20×50');
  expect(requests).toHaveLength(1);
  expect(requests[0]).toMatchObject({ message: '높이를 50mm로 바꿔줘', selectedId: 'box_1', history: [] });

  const reply = page.locator('.msg[data-kind="commands"]');
  await expect(reply).toContainText('높이를 50mm로 바꿨습니다.');
  await expect(reply.getByRole('list', { name: '적용한 변경' })).toHaveText('큐브 높이 50mm');
  await expect(reply).toContainText('예상 비용 $0.02');
  await expect(page.getByTestId('ai-month-cost')).toHaveText('이번 달 $0.02');

  // 보낸 직후 포커스는 빈 채팅 입력창 → Ctrl+Z 가 AI 변경 전체를 한 번에 되돌린다
  await expect(page.getByLabel('AI 에게 보낼 메시지')).toBeFocused();
  await page.keyboard.press('Control+z');
  await expect(page.locator('.object-list')).toContainText('20×20×20');
  // 입력 중인 글이 있으면 Ctrl+Z 는 글자 실행 취소 (모델은 그대로)
  await page.keyboard.press('Control+Shift+z');
  await expect(page.locator('.object-list')).toContainText('20×20×50');
  await page.getByLabel('AI 에게 보낼 메시지').fill('입력 중');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.object-list')).toContainText('20×20×50');
  expect(requests).toHaveLength(1);
});

test('정보가 부족하면 질문 → 선택지 클릭이 답이 되고, 이전 대화가 함께 전달된다', async ({ page }) => {
  const requests = await mockAi(page, [
    { kind: 'question', message: '컵의 지름과 높이를 어떻게 할까요?', options: ['지름 80mm, 높이 100mm', '지름 70mm, 높이 90mm'] },
    {
      kind: 'commands', message: '컵을 만들었습니다.',
      commands: [
        { type: 'create_cylinder', id: 'cup_body', name: '컵', radius: 40, height: 100, position: [60, 0, 0] },
        { type: 'create_cylinder', id: 'cup_inside', radius: 37, height: 100, position: [60, 0, 3] },
        { type: 'cut', id: 'cup', name: '컵', base: 'cup_body', tools: ['cup_inside'] },
      ],
    },
  ]);
  await page.goto('/');
  await say(page, '컵 만들어줘');
  const question = page.locator('.msg[data-kind="question"]');
  await expect(question).toContainText('컵의 지름과 높이');
  await question.getByRole('button', { name: '지름 80mm, 높이 100mm' }).click();

  await expect(page.locator('.object-list li')).toHaveCount(4); // 큐브 + 컵(빼기) + 자식 2
  expect(requests).toHaveLength(2);
  expect(requests[1]!.message).toBe('지름 80mm, 높이 100mm');
  expect(requests[1]!.history).toEqual([
    { role: 'user', text: '컵 만들어줘' },
    { role: 'assistant', text: '컵의 지름과 높이를 어떻게 할까요?\n[선택지] 지름 80mm, 높이 100mm / 지름 70mm, 높이 90mm' },
  ]);
  await page.keyboard.press('Control+z');
  await expect(page.locator('.object-list li')).toHaveCount(1); // 명령 3개가 한 단계
});

test('적용할 수 없는 AI 명령은 모델을 바꾸지 않는다', async ({ page }) => {
  await mockAi(page, [{ kind: 'commands', message: '삭제했습니다.', commands: [{ type: 'delete_object', target: 'ghost' }] }]);
  await page.goto('/');
  await say(page, '유령 지워줘');
  await expect(page.locator('.msg[data-kind="error"]')).toContainText('적용하지 못했습니다');
  await expect(page.locator('.object-list li')).toHaveCount(1);
});

test('API 키가 없으면 안내하고 보내지 않는다 → 설정 창에서 키 저장(로컬 서버)', async ({ page }) => {
  let chatCalls = 0;
  await page.route('**/api/ai/chat', (r) => {
    chatCalls++;
    return r.abort();
  });
  await page.goto('/');
  await expect(page.getByTestId('ai-unavailable')).toContainText('API 키가 필요합니다');
  await expect(page.getByLabel('AI 에게 보낼 메시지')).toBeDisabled();

  await page.getByTestId('ai-unavailable').getByRole('button', { name: 'AI 설정' }).click();
  const dialog = page.getByRole('dialog', { name: 'AI 설정 · 사용량' });
  await dialog.getByLabel('API 키').fill('sk-ant-e2e-test-key-5678');
  await dialog.getByRole('button', { name: '저장', exact: true }).click();
  await expect(dialog.getByRole('status')).toHaveText('API 키를 저장했습니다');
  await expect(dialog.getByLabel('API 키')).toHaveAttribute('placeholder', /저장됨 …5678/);
  await expect(dialog.getByTestId('usage-이번 달')).toContainText('$0');
  await dialog.getByRole('button', { name: '삭제' }).click(); // 테스트용 키 정리
  await expect(dialog.getByRole('status')).toHaveText('API 키를 삭제했습니다');
  await dialog.getByRole('button', { name: '닫기' }).click();
  expect(chatCalls).toBe(0);
});

test('백엔드 없는 웹에서는 AI 를 쓸 수 없다고 안내하고 모델링은 그대로', async ({ page }) => {
  await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
  await page.goto('/');
  await expect(page.getByTestId('ai-unavailable')).toContainText('로컬 서버에 연결되면');
  await expect(page.getByLabel('AI 에게 보낼 메시지')).toBeDisabled();
  await page.getByRole('button', { name: '+ 구' }).click();
  await expect(page.locator('.object-list li')).toHaveCount(2);
});
