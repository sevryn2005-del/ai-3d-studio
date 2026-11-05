/**
 * 형식 v18 타원 (두 엔진): 타원 도구로 바운딩 박스 드래그 → 돌출 → 방향 90° → 지름 바꾸기.
 * 부피는 공유 픽스처(ellipse-*)가 세 엔진에서 검사한다.
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());

for (const engine of ['server', 'browser'] as const) {
  test(`타원 그리기·돌출·방향·지름 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    test.setTimeout(90_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);

    // 1. 타원 도구: (−15, −5) → (15, 5) 드래그 = 지름 30 × 10
    await page.getByRole('tab', { name: '스케치' }).click();
    await page.getByTestId('cmd-ellipse').click();
    const a = await at(-15, -5);
    const b = await at(15, 5);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move((a.x + b.x) / 2, (a.y + b.y) / 2, { steps: 4 });
    await page.mouse.move(b.x, b.y, { steps: 4 });
    await page.mouse.up();
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('dim-ellipse1.width')).toHaveValue('30');
    await expect(page.getByTestId('dim-ellipse1.height')).toHaveValue('10');

    // 2. 돌출 → 범위 x ±15, y ±5
    await page.getByTestId('extrude-ellipse1').click();
    await expect.poll(async () => (await sources(page)).extrude_1?.source, { timeout: 30_000 }).toBe(engine);
    const e = (await sources(page)).extrude_1!;
    expect(e.max[0]).toBeCloseTo(15, 1);
    expect(e.max[1]).toBeCloseTo(5, 1);

    // 3. 방향 90° → 범위가 바뀐다 (x ±5, y ±15), 짧은 지름 10 → 6
    await page.locator('[data-sketch-id="sketch_1"]').click();
    await page.getByTestId('angle-ellipse1').fill('90');
    await page.getByTestId('angle-ellipse1').press('Enter');
    await expect.poll(async () => (await sources(page)).extrude_1?.max[1] ?? 0, { timeout: 30_000 }).toBeCloseTo(15, 1);
    await page.getByTestId('dim-ellipse1.height').fill('6');
    await page.getByTestId('dim-ellipse1.height').press('Enter');
    await expect.poll(async () => (await sources(page)).extrude_1?.max[0] ?? 0, { timeout: 30_000 }).toBeCloseTo(3, 1);
  });
}
