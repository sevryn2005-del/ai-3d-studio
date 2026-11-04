/** 형식 v8 화면 흐름 (두 엔진): 원통 나사산, 두 스케치 로프트, STL 가져오기 */
import { writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());

/** 바깥을 향하는 10mm 정육면체 이진 STL */
function cubeStl(path: string) {
  const v = [[0, 0, 0], [10, 0, 0], [10, 10, 0], [0, 10, 0], [0, 0, 10], [10, 0, 10], [10, 10, 10], [0, 10, 10]];
  const f = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [1, 2, 6], [1, 6, 5], [2, 3, 7], [2, 7, 6], [3, 0, 4], [3, 4, 7]];
  const buf = Buffer.alloc(84 + f.length * 50);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((t, i) => t.forEach((vi, k) => v[vi]!.forEach((c, j) => buf.writeFloatLE(c + 100, 84 + i * 50 + 12 + k * 12 + j * 4))));
  writeFileSync(path, buf);
}

for (const engine of ['server', 'browser'] as const) {
  test(`나사산·로프트·STL 가져오기 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }, info) => {
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);

    // 원통 → 나사산 (헬릭스 + 합치기 한 묶음)
    await page.getByRole('button', { name: '+ 원통' }).click();
    await page.getByTestId('cmd-thread').click();
    await expect.poll(async () => (await sources(page)).union_1?.source, { timeout: 30_000 }).toBe(engine);
    const thread = (await sources(page)).union_1!;
    expect(thread.max[0]! - thread.min[0]!).toBeGreaterThan(21.5); // 원통 Ø20 + 산 높이 0.9 × 2
    expect(thread.vertices).toBeGreaterThan(1000);

    // 로프트: XY 0 사각형 + XY 20 원
    await page.getByRole('tab', { name: '스케치' }).click();
    for (const [offset, kind] of [['0', '+ 사각형'], ['20', '+ 원']] as const) {
      await page.locator('[data-plane="XY"]').click();
      await page.getByTestId('cmd-sketch').click();
      await page.getByTestId('sketch-plane-offset').fill(offset);
      await page.getByTestId('sketch-plane-offset').press('Enter');
      await page.getByRole('button', { name: kind, exact: true }).click();
    }
    await page.getByRole('tab', { name: '피처' }).click();
    await page.getByTestId('cmd-loft').click();
    const panel = page.getByTestId('loft-panel');
    await panel.getByRole('checkbox').nth(-2).check();
    await panel.getByRole('checkbox').nth(-1).check();
    await page.getByTestId('loft-ok').click();
    await expect.poll(async () => (await sources(page)).loft_1?.max[2], { timeout: 20_000 }).toBe(20);

    // STL 가져오기: 원점 규칙(바닥면 중심)으로 옮겨짐
    const file = info.outputPath('cube.stl');
    cubeStl(file);
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-mesh').click()]);
    await chooser.setFiles(file);
    await expect.poll(async () => (await sources(page)).mesh_1?.source, { timeout: 30_000 }).toBe(engine);
    const m = (await sources(page)).mesh_1!;
    expect(m.max[2]! - m.min[2]!).toBeCloseTo(10, 3);
    await expect(page.getByTestId('notice')).toContainText('삼각형 12개');
  });
}
