/**
 * 도면 (두 엔진): 블록 + 막힌 구멍 → 도면 탭 → 3각법 시트(숨은선·자동 치수·표제란) → 척도·보기 바꾸기 → SVG·DXF 저장.
 * 투상 값은 공유 픽스처(drawing-cases.json)가 두 엔진에서 검사한다.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => window.__AI3D_DEV__!.dispatch(c), cmd);

for (const engine of ['server', 'browser'] as const) {
  test(`도면 만들기·저장 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    test.setTimeout(90_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    await dispatch(page, { type: 'create_box', id: 'b', width: 40, depth: 20, height: 10 });
    await dispatch(page, { type: 'hole', id: 'h', target: 'b', face: 'top', at: [0, 0], diameter: 6, depth: 5 });

    await page.getByRole('tab', { name: '도면' }).click();
    await page.getByTestId('cmd-drawing').click();
    const sheet = page.getByTestId('drawing-sheet');
    await expect(sheet).toBeVisible({ timeout: 40_000 });
    await expect(sheet).toHaveAttribute('data-scale', '2');
    const svgText = () => sheet.locator('svg').textContent();
    expect(await svgText()).toContain('Ø6');
    for (const t of ['40', '10', '20', '정면도', '평면도', '우측면도', '등각도', '2:1', '3각법']) await expect(sheet.locator('text', { hasText: t }).first()).toBeAttached();
    expect(await sheet.locator('polyline.hidden').count()).toBeGreaterThan(0); // 구멍 숨은선

    // 제목·척도·보기·치수 바꾸기
    await page.getByTestId('drawing-title').fill('받침 블록');
    await expect(sheet.locator('text', { hasText: '받침 블록' })).toBeAttached();
    await page.getByTestId('drawing-scale').selectOption('1');
    await expect(sheet).toHaveAttribute('data-scale', '1');
    await page.getByTestId('drawing-view-iso').uncheck();
    await expect(sheet.locator('text', { hasText: '등각도' })).toHaveCount(0);
    await page.getByTestId('drawing-dims').uncheck();
    await expect(sheet.locator('text', { hasText: 'Ø6' })).toHaveCount(0);
    await page.getByTestId('drawing-dims').check();

    // 모델을 고치면 도면이 따라 바뀐다 (폭 40 → 60)
    await dispatch(page, { type: 'set_params', target: 'b', params: { width: 60 } });
    await expect(sheet.locator('text', { hasText: /^60$/ })).toBeAttached({ timeout: 40_000 });

    // SVG·DXF 저장
    const [svgDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('drawing-svg').click()]);
    expect(svgDl.suggestedFilename()).toBe('받침 블록 도면.svg');
    const svg = readFileSync((await svgDl.path())!, 'utf8');
    expect(svg).toContain('width="297mm"');
    expect(svg).toContain('받침 블록');
    const [dxfDl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('drawing-dxf').click()]);
    expect(dxfDl.suggestedFilename()).toBe('받침 블록 도면.dxf');
    const dxf = readFileSync((await dxfDl.path())!, 'utf8');
    expect(dxf).toContain('AC1009');
    expect(dxf).toContain('HIDDEN');

    // 닫기 (Esc) → 3D 화면으로
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('drawing-window')).toHaveCount(0);
  });
}
