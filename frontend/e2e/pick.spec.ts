/**
 * 화면에서 면·모서리 고르기 (형식 v12, 두 엔진): 필렛 모서리 → 측정 → 메이트 면 → 면 위 스케치.
 * 클릭 위치 = 3D 점을 화면에 투영한 곳 (모서리는 화면 8px 이내, 면은 그 아래)
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const scene = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => window.__AI3D_DEV__!.dispatch(c), cmd);
async function clickAt(page: Page, x: number, y: number, z: number) {
  const p = await page.evaluate(([x, y, z]) => window.__AI3D_DEV__!.project(x!, y!, z!), [x, y, z]);
  await page.mouse.click(p.x, p.y);
}
const ready = (page: Page) => expect(page.getByTestId('pick-bar')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });

for (const engine of ['server', 'browser'] as const) {
  test(`면·모서리 고르기: 필렛·측정·메이트·면 위 스케치 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    test.setTimeout(120_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);

    // 1. 필렛 → 화면에서 위 모서리 두 개만 고르기 (큐브 20: 위 앞·뒤 모서리 가운데)
    await page.locator('[data-object-id="box_1"]').click();
    await page.getByTestId('cmd-fillet').click();
    await expect.poll(async () => (await sources(page)).fillet_1?.source, { timeout: 60_000 }).toBe(engine);
    const all = (await sources(page)).fillet_1!.vertices;
    await page.locator('[data-object-id="fillet_1"]').click();
    await page.getByTestId('ef-pick').click();
    await ready(page);
    await clickAt(page, 0, -10, 20);
    await clickAt(page, 10, 0, 20);
    await expect(page.getByTestId('pick-count')).toHaveText('고름 2개');
    await page.getByTestId('pick-done').click();
    await expect(page.getByTestId('pick-bar')).toHaveCount(0);
    await expect.poll(async () => (await sources(page)).fillet_1?.vertices ?? 0, { timeout: 30_000 }).toBeLessThan(all);
    await expect(page.getByRole('list', { name: '객체 목록' })).toContainText('고른 모서리 2개');

    // 2. 면·모서리 측정: 원통 위 원 모서리 → 지름
    await dispatch(page, { type: 'create_cylinder', id: 'cyl', radius: 5, height: 8, position: [40, 0, 0] });
    await expect.poll(async () => (await sources(page)).cyl?.source, { timeout: 30_000 }).toBe(engine);
    await page.getByRole('tab', { name: '보기' }).click();
    await page.getByTestId('cmd-measure-entity').click();
    await ready(page);
    await clickAt(page, 40, -5, 8);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('measure-지름')).toHaveText('10 mm');

    // 3. 메이트: 필렛 큐브 윗면(이름 면) ↔ 새 상자 윗면, 같은 방향 → 상자 윗면이 높이 20 에
    await dispatch(page, { type: 'create_box', id: 'lid', width: 10, depth: 10, height: 4, position: [0, -45, 0] });
    await page.getByRole('tab', { name: '조립품' }).click();
    await page.getByTestId('cmd-mate').click();
    const panel = page.getByTestId('mate-panel');
    await panel.getByTestId('mate-type').selectOption('coincident');
    await panel.getByTestId('mate-pick-a').click();
    await ready(page);
    await clickAt(page, -3, 3, 20); // 큐브 윗면 (모서리에서 떨어진 곳)
    await expect(page.getByTestId('pick-bar')).toHaveCount(0);
    await panel.getByTestId('mate-pick-b').click();
    await ready(page);
    await clickAt(page, 2, -43, 4); // 새 상자 윗면
    await panel.getByTestId('mate-flip').check();
    await panel.getByTestId('mate-ok').click();
    await expect.poll(async () => (await scene(page)).mates.map((m) => m.refs.join(' ')), { timeout: 10_000 }).toEqual(['fillet_1.top lid.top']);
    await expect.poll(async () => (await sources(page)).lid?.max[2] ?? 0, { timeout: 30_000 }).toBeCloseTo(20, 3);

    // 4. 면에 스케치: 원통 윗면 클릭 → 이름 있는 면이라 face 평면
    await page.getByRole('tab', { name: '스케치' }).click();
    await page.getByTestId('cmd-sketch-face').click();
    await ready(page);
    await clickAt(page, 41, 1, 8);
    await expect.poll(async () => (await scene(page)).sketches.at(-1)?.plane, { timeout: 10_000 }).toEqual({ type: 'face', object: 'cyl', face: 'top', offset: 0 });
  });
}

for (const engine of ['server', 'browser'] as const) {
  test(`면 이동 (형식 v39, ${engine === 'server' ? 'CadQuery 서버' : '브라우저 OCCT'}): 윗면 클릭 → 5 밀기 → −4 당기기 → 옆면 다시 고르기`, async ({ page }) => {
    test.setTimeout(120_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.getByTestId('cmd-move-face').click();
    await ready(page);
    await clickAt(page, 3, -2, 20); // 큐브 20 윗면
    await expect(page.getByTestId('pick-bar')).toHaveCount(0);
    await expect.poll(async () => (await sources(page)).pattern_1?.max, { timeout: 60_000 }).toEqual([10, 10, 25]);
    await page.locator('[data-object-id="pattern_1"]').click();
    await page.getByTestId('face-distance').fill('-4');
    await page.getByTestId('face-distance').press('Enter');
    await expect.poll(async () => (await sources(page)).pattern_1?.max, { timeout: 60_000 }).toEqual([10, 10, 16]);
    // 앞면(−Y)으로 바꾸기 → 앞쪽이 4 줄어든다
    await page.getByTestId('face-repick').click();
    await ready(page);
    await clickAt(page, 2, -10, 8);
    await expect.poll(async () => (await sources(page)).pattern_1?.min, { timeout: 60_000 }).toEqual([-10, -6, 0]);
    expect((await sources(page)).pattern_1!.max).toEqual([10, 10, 20]);
  });
}

for (const engine of ['server', 'browser'] as const) {
  test(`돔 (형식 v40, ${engine === 'server' ? 'CadQuery 서버' : '브라우저 OCCT'}): 윗면 클릭 → 높이 5 → 8 → 오목 −4`, async ({ page }, info) => {
    test.setTimeout(120_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.getByTestId('cmd-dome').click();
    await ready(page);
    await clickAt(page, 3, -2, 20);
    await expect.poll(async () => (await sources(page)).pattern_1?.max[2], { timeout: 60_000 }).toBeCloseTo(25, 3);
    await page.locator('[data-object-id="pattern_1"]').click();
    await page.getByTestId('dome-height').fill('8');
    await page.getByTestId('dome-height').press('Enter');
    await expect.poll(async () => (await sources(page)).pattern_1?.max[2], { timeout: 60_000 }).toBeCloseTo(28, 3);
    if (engine === 'server') await page.screenshot({ path: info.outputPath('dome.png') });
    await page.getByTestId('dome-height').fill('-4');
    await page.getByTestId('dome-height').press('Enter');
    await expect.poll(async () => (await sources(page)).pattern_1?.max[2], { timeout: 60_000 }).toBeCloseTo(20, 3);
    await expect(page.getByRole('alert')).toHaveCount(0);
  });
}
