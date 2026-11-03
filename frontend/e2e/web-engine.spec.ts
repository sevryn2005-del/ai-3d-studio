/**
 * 웹(백엔드 없음) 시나리오: 브라우저 CAD 엔진이 서버와 같은 결과를 낸다 (개발 모드, DevProbe 사용).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());

test.beforeEach(async ({ page }) => {
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.abort('connectionrefused'));
});

test('브라우저 엔진: 높이 50 → 실제 형상 50mm, 박스 − 원통 구멍, 구멍 반지름 수정', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe('browser');

  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');
  await expect.poll(async () => (await sources(page)).box_1?.max[2]).toBe(50);

  // 원통을 박스 중앙에 관통시켜 빼기
  await page.getByRole('button', { name: '+ 원통' }).click();
  const pos = (l: string) => page.locator('fieldset', { hasText: /^위치/ }).getByLabel(l, { exact: true });
  await pos('X').fill('0');
  await pos('X').press('Enter');
  await pos('Z').fill('-1');
  await pos('Z').press('Enter');
  await page.getByTestId('param-height').fill('60');
  await page.getByTestId('param-height').press('Enter');
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByLabel('연산 대상').selectOption('cylinder_1');
  await page.getByRole('button', { name: '빼기', exact: true }).click();

  await expect.poll(async () => (await sources(page)).cut_1?.source, { timeout: 20_000 }).toBe('browser');
  const holed = (await sources(page)).cut_1!;
  expect(holed.min).toEqual([-10, -10, 0]);
  expect(holed.max).toEqual([10, 10, 50]);
  expect(holed.vertices).toBeGreaterThan(24);

  await page.locator('[data-object-id="cylinder_1"]').click();
  await page.getByTestId('param-radius').fill('6');
  await page.getByTestId('param-radius').press('Enter');
  await expect.poll(async () => (await sources(page)).cut_1?.vertices, { timeout: 20_000 }).not.toBe(holed.vertices);
  await expect(page.getByTestId('server-evaluation')).toHaveText('브라우저 계산 ✓');
});

test('브라우저 엔진 3MF: 구멍 뚫린 형상이 단위 mm·매니폴드로 저장된다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('cad-engine')).toHaveText('CAD: 브라우저 엔진');
  await page.getByRole('button', { name: '내보내기 ▾' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^3MF/ }).click(),
  ]);
  const bytes = readFileSync((await download.path())!);
  expect(bytes.subarray(0, 2).toString()).toBe('PK');
});
