/**
 * 형식 v10 화면 흐름 (두 엔진): 경로 그리기 → 리브 → 두께·꺾임 둥글기 → 단면 스케치 → 스윕.
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());

for (const engine of ['server', 'browser'] as const) {
  test(`경로·리브·스케치 필렛·스윕 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
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

    // 1. 경로 그리기 (스케치 탭 → 경로): 세 점 → Enter
    await page.getByRole('tab', { name: '스케치' }).click();
    await page.getByTestId('cmd-path').click();
    await click(0, 0);
    await click(30, 0);
    await click(30, 20);
    await page.keyboard.press('Enter');
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('pt-path1.p2-y')).toHaveValue('20');

    // 2. 리브: 두께 2 × 높이 10
    await page.getByRole('tab', { name: '피처' }).click();
    await page.getByTestId('cmd-rib').click();
    await expect(page.getByRole('list', { name: '객체 목록' })).toContainText('리브 1');
    await expect.poll(async () => (await sources(page)).extrude_1?.source, { timeout: 30_000 }).toBe(engine);
    const rib = (await sources(page)).extrude_1!;
    expect(rib.max[2]).toBeCloseTo(10, 3);
    expect(rib.min[1]).toBeCloseTo(-1, 3);

    // 3. 두께 3 → 바깥면이 1.5 로, 꺾인 곳 둥글게(R6) → 정점이 늘어난다
    await page.locator('[data-object-id="extrude_1"]').click();
    await page.getByTestId('rib-thin').fill('3');
    await page.getByTestId('rib-thin').press('Enter');
    await expect.poll(async () => (await sources(page)).extrude_1?.min[1] ?? 0, { timeout: 30_000 }).toBeCloseTo(-1.5, 3);
    const sharp = (await sources(page)).extrude_1!.vertices;
    await page.getByTestId('corner-size').fill('6');
    await page.getByTestId('corner-size').press('Enter');
    await expect.poll(async () => (await sources(page)).extrude_1?.vertices ?? 0, { timeout: 30_000 }).toBeGreaterThan(sharp);

    // 4. 단면 스케치(YZ 평면 원 Ø4) → 스윕 패널에서 단면·경로 고르기
    for (const c of [
      { type: 'create_sketch', id: 'sp', plane: { type: 'YZ', offset: 0 } },
      { type: 'add_circle', sketch: 'sp', id: 'c1', center: [0, 0], diameter: 4 },
    ])
      await page.evaluate((cmd) => window.__AI3D_DEV__!.dispatch(cmd), c);
    await page.getByTestId('cmd-sweep').click();
    const panel = page.getByTestId('sweep-panel');
    const c1 = await panel.getByTestId('sweep-profile').locator('option', { hasText: 'c1' }).getAttribute('value');
    await panel.getByTestId('sweep-profile').selectOption(c1!);
    await page.getByTestId('sweep-ok').click();
    await expect.poll(async () => (await sources(page)).sweep_1?.source, { timeout: 30_000 }).toBe(engine);
    const sw = (await sources(page)).sweep_1!;
    expect(sw.min[0]).toBeCloseTo(0, 2); // 경로 시작점에 세운 단면
    expect(sw.max[1]).toBeCloseTo(20, 2); // 경로 끝
    expect(sw.max[2]! - sw.min[2]!).toBeCloseTo(4, 2); // 원 지름 (경로 평면 법선 방향)
  });
}
