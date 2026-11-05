/**
 * 형식 v16 스플라인 (두 엔진): 스플라인 도구로 닫힌 곡선 그리기 → 돌출 → 스플라인 끄면 꺾은 다각형.
 * 곡선·부피는 공유 픽스처(spline-*)가 세 엔진에서 검사한다.
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());

for (const engine of ['server', 'browser'] as const) {
  test(`스플라인 그리기·돌출·끄기 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    test.setTimeout(90_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.getByRole('button', { name: '삭제', exact: true }).click();

    const click = async (x: number, y: number) => {
      const p = await page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
      await page.mouse.click(p.x, p.y);
    };
    // 1. 스플라인 도구: 네 점 → 첫 점 다시 클릭 = 닫힌 곡선
    await page.getByRole('tab', { name: '스케치' }).click();
    await page.getByTestId('cmd-spline').click();
    for (const [x, y] of [[-10, -10], [10, -10], [10, 10], [-10, 10], [-10, -10]] as const) await click(x, y);
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('spline-poly1')).toBeChecked();
    // 스플라인에는 필렛·호 입력이 없다
    await expect(page.getByTestId('corner-size')).toHaveCount(0);
    await expect(page.getByTestId('bulge-poly1.e0')).toHaveCount(0);

    // 2. 돌출 → 곡선이 꼭짓점 밖으로 부푼다 (꼭짓점 범위 ±10 보다 큼)
    await page.getByTestId('extrude-poly1').click();
    await expect.poll(async () => (await sources(page)).extrude_1?.source, { timeout: 30_000 }).toBe(engine);
    expect((await sources(page)).extrude_1!.max[0]).toBeGreaterThan(11);

    // 3. 스플라인 끄기 → 꺾은 다각형 (범위 ±10)
    await page.locator('[data-sketch-id="sketch_1"]').click();
    await page.getByTestId('spline-poly1').uncheck();
    await expect.poll(async () => (await sources(page)).extrude_1?.max[0] ?? 0, { timeout: 30_000 }).toBeCloseTo(10, 2);
  });
}
