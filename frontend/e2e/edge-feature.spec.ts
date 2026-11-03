import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());

for (const engine of ['server', 'browser'] as const) {
  test(`모서리 둥글게·모따기 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    if (engine === 'browser') {
      await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    }
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    const plain = (await sources(page)).box_1!;

    await page.getByLabel('처리').selectOption('fillet');
    await expect(page.locator('.object-list')).toContainText('20×20×20 R2');
    await expect.poll(async () => (await sources(page)).box_1?.vertices, { timeout: 20_000 }).toBeGreaterThan(plain.vertices * 4);
    const rounded = (await sources(page)).box_1!;
    expect(rounded.min).toEqual([-10, -10, 0]); // 원점 규칙·외형 크기 유지
    expect(rounded.max).toEqual([10, 10, 20]);

    // 너무 큰 반지름은 거부 (가장 짧은 변 20mm 의 절반 미만)
    const size = page.getByTestId('edge-size');
    await size.fill('10');
    await size.press('Enter');
    await expect(page.getByRole('alert')).toContainText('너무 큽니다');
    await expect(size).toHaveValue('2');

    // 세로 모서리 모따기
    await page.getByLabel('처리').selectOption('chamfer');
    await page.getByLabel('범위').selectOption('vertical');
    await expect(page.locator('.object-list')).toContainText('20×20×20 C2 세로');
    await expect.poll(async () => (await sources(page)).box_1?.vertices, { timeout: 20_000 }).not.toBe(rounded.vertices);

    // 실행 취소 3번 → 각진 박스
    for (let i = 0; i < 3; i++) await page.keyboard.press('Control+z');
    await expect(page.locator('.object-list')).toContainText(/20×20×20$/);
    await expect.poll(async () => (await sources(page)).box_1?.vertices).toBe(plain.vertices);
  });
}
