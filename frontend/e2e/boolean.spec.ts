import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const field = (page: Page, legend: RegExp, label: string) =>
  page.locator('fieldset', { hasText: legend }).getByLabel(label, { exact: true });

async function setNumber(page: Page, legend: RegExp, label: string, value: string) {
  const f = field(page, legend, label);
  await f.fill(value);
  await f.press('Enter');
}

test('박스에서 원통을 빼서 구멍 → 구멍 반지름 수정 → 실행 취소', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);

  // 원통을 박스 중앙으로, 박스를 관통하도록 아래로
  await page.getByRole('button', { name: '+ 원통' }).click();
  await setNumber(page, /^위치/, 'X', '0');
  await setNumber(page, /^위치/, 'Z', '-1');
  await page.getByTestId('param-radius').fill('4');
  await page.getByTestId('param-radius').press('Enter');
  await page.getByTestId('param-height').fill('30');
  await page.getByTestId('param-height').press('Enter');

  // 큐브 선택 → 원통 빼기
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByLabel('연산 대상').selectOption('cylinder_1');
  await page.getByRole('button', { name: '빼기', exact: true }).click();

  // 객체 트리: 빼기 1 아래에 큐브, 원통
  await expect(page.locator('.object-list li')).toHaveText([/빼기 1/, /큐브/, /원통 1/]);
  await expect(page.locator('.props')).toContainText('유형: 빼기');

  // 서버가 계산한 구멍 뚫린 메시가 표시된다 (박스 12삼각형보다 훨씬 많음)
  await expect.poll(async () => (await sources(page)).cut_1?.source, { timeout: 20_000 }).toBe('server');
  const holed = (await sources(page)).cut_1!;
  expect(holed.vertices).toBeGreaterThan(24);
  expect(holed.min).toEqual([-10, -10, 0]);
  expect(holed.max).toEqual([10, 10, 20]);

  // 포함된 원통 선택 → 고스트 표시 → 반지름 변경 → 결과 재계산
  await page.locator('[data-object-id="cylinder_1"]').click();
  await expect(page.locator('.props')).toContainText('상위: 빼기 1');
  await expect(page.locator('fieldset', { hasText: /^위치/ })).toContainText('빼기 1 기준');
  await expect.poll(async () => (await sources(page)).cylinder_1?.source).toBe('ghost');
  await page.getByTestId('param-radius').fill('6');
  await page.getByTestId('param-radius').press('Enter');
  await expect.poll(async () => (await sources(page)).cut_1?.vertices, { timeout: 20_000 }).not.toBe(holed.vertices);
  await expect(page.getByTestId('server-evaluation')).toHaveText('서버 검증 ✓');

  // 자식은 단독 삭제 불가 (버튼 비활성)
  await expect(page.locator('.props').getByRole('button', { name: '삭제' })).toBeDisabled();

  // 실행 취소 2번 (반지름 변경, 빼기) → 다시 두 개의 독립 객체
  await page.keyboard.press('Control+z');
  await page.keyboard.press('Control+z');
  await expect(page.locator('.object-list li')).toHaveText([/큐브/, /원통 1/]);
});
