/**
 * 형식 v9 화면 흐름 (두 엔진): 모서리 필렛·규칙 변경, 구배, STEP 가져오기, STEP 내보내기.
 * 브라우저 엔진은 이 객체들만 OCCT(WASM) 정밀 엔진으로 계산하고 나머지는 manifold 그대로다.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const STEP_SAMPLE = fileURLToPath(new URL('../../shared/samples/block-hole.step', import.meta.url));

for (const engine of ['server', 'browser'] as const) {
  test(`필렛·구배·STEP 가져오기·내보내기 (${engine === 'server' ? 'CadQuery 서버' : '브라우저 OCCT'} 엔진)`, async ({ page }) => {
    test.setTimeout(120_000); // 브라우저: 정밀 엔진 WASM 첫 로드 포함
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    const box = (await sources(page)).box_1!;

    // 구배 3° (솔리드웍스와 같은 순서: 구배 먼저, 필렛 나중): 바닥은 그대로, 위가 좁아진다
    await page.locator('[data-object-id="box_1"]').click();
    await page.getByTestId('cmd-draft').click();
    await expect.poll(async () => (await sources(page)).draft_1?.source, { timeout: 60_000 }).toBe(engine);
    const drafted = (await sources(page)).draft_1!;
    expect(drafted.max[2]).toBeCloseTo(box.max[2]!, 3);
    expect(drafted.max[0]).toBeCloseTo(box.max[0]!, 3); // 가장 넓은 곳 = 바닥

    // 필렛 (모든 모서리) → 같은 크기, 곡면이라 정점이 훨씬 많다
    await page.getByTestId('cmd-fillet').click();
    await expect(page.getByRole('list', { name: '객체 목록' })).toContainText('필렛 1');
    await expect.poll(async () => (await sources(page)).fillet_1?.source, { timeout: 30_000 }).toBe(engine);
    const all = (await sources(page)).fillet_1!;
    expect(all.vertices).toBeGreaterThan(drafted.vertices * 4);
    expect(all.max[2]).toBeCloseTo(box.max[2]!, 3);

    // 규칙 → 위 모서리만: 다시 계산되어 정점 수가 줄어든다
    await page.locator('[data-object-id="fillet_1"]').click();
    await page.getByTestId('ef-edges').selectOption('top');
    await expect.poll(async () => (await sources(page)).fillet_1?.vertices ?? 0, { timeout: 30_000 }).toBeLessThan(all.vertices);

    // STEP 가져오기: CadQuery 로 만든 10×20×30 블록(구멍) → 바닥면 중심 원점
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-mesh').click()]);
    await chooser.setFiles(STEP_SAMPLE);
    await expect.poll(async () => (await sources(page)).step_1?.source, { timeout: 30_000 }).toBe(engine);
    const s = (await sources(page)).step_1!;
    expect(s.max[0]! - s.min[0]!).toBeCloseTo(10, 3);
    expect(s.max[1]! - s.min[1]!).toBeCloseTo(20, 3);
    expect(s.min[2]).toBeCloseTo(0, 3);
    expect(s.max[2]).toBeCloseTo(30, 3);
    await expect(page.getByTestId('notice')).toContainText('STEP');

    // STEP 내보내기 (브라우저 엔진도 OCCT 로)
    await page.getByRole('button', { name: '내보내기 ▾' }).click();
    const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^STEP/ }).click()]);
    const bytes = readFileSync((await download.path())!);
    expect(bytes.subarray(0, 12).toString()).toBe('ISO-10303-21');
    expect(bytes.toString()).toContain('MANIFOLD_SOLID_BREP');
  });
}

test('가변 반경 필렛 (형식 v38): 세로 모서리 필렛 → 가변 켜기(끝 = 2배) → 끝 반지름 → 끄기, 저장', async ({ page }) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  const src = async () => await page.evaluate(() => window.__AI3D_DEV__!.meshSources());
  await expect.poll(async () => (await src()).box_1?.source, { timeout: 20_000 }).toBe('server');
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByTestId('cmd-fillet').click();
  await expect.poll(async () => (await src()).fillet_1?.source, { timeout: 60_000 }).toBe('server');
  await page.locator('[data-object-id="fillet_1"]').click();
  await page.getByTestId('ef-edges').selectOption('vertical');
  await page.getByTestId('ef-size').fill('2');
  await page.getByTestId('ef-size').press('Enter');
  await expect.poll(async () => (await src()).fillet_1?.source, { timeout: 60_000 }).toBe('server');
  const even = (await src()).fillet_1!.vertices;
  await page.getByTestId('ef-variable').check();
  await expect(page.getByTestId('ef-size2')).toHaveValue('4');
  await expect.poll(async () => (await src()).fillet_1?.vertices, { timeout: 60_000 }).not.toBe(even);
  await page.getByTestId('ef-size2').fill('6');
  await page.getByTestId('ef-size2').press('Enter');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(46);
  expect(saved.model.objects.find((o: { id: string }) => o.id === 'fillet_1').fillet).toMatchObject({ type: 'fillet', size: 2, size2: 6, edges: 'vertical' });
  await page.getByTestId('ef-variable').uncheck();
  await expect(page.getByTestId('ef-size2')).toHaveCount(0);
  await expect(page.getByRole('alert')).toHaveCount(0);
});
