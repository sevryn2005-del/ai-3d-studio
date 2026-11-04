/** 형식 v7 화면 흐름 (두 엔진): 면 위 스케치 → 슬롯 → 돌출 컷, 크기 조정, 각도 평면, 구성선, 직교 보기 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());

for (const engine of ['server', 'browser'] as const) {
  test(`슬롯 돌출 컷·크기 조정·각도 평면·구성선·직교 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);

    // 큐브(선택됨) 윗면에 스케치 → 슬롯
    await page.getByRole('tab', { name: '스케치' }).click();
    await page.getByTestId('cmd-sketch').click();
    await page.getByTestId('cmd-slot').click();
    await expect(page.getByTestId('dim-slot1.length')).toHaveValue('20');
    await page.getByTestId('dim-slot1.length').fill('8');
    await page.getByTestId('dim-slot1.length').press('Enter');
    await page.getByTestId('angle-slot1').fill('90');
    await page.getByTestId('angle-slot1').press('Enter');

    // 돌출 컷: 대상 = 큐브, 면 안쪽으로 10mm
    await page.getByRole('tab', { name: '피처' }).click();
    await page.getByTestId('cmd-extrude-cut').click();
    await expect(page.getByTestId('pm-cut')).toHaveValue('box_1');
    await expect(page.getByTestId('pm-reverse')).toBeChecked();
    await page.getByTestId('pm-ok').click();
    await expect.poll(async () => (await sources(page)).cut_1?.source, { timeout: 20_000 }).toBe(engine);
    expect((await sources(page)).cut_1!.max[2]).toBe(20); // 외형 그대로 (홈)
    await expect(page.getByRole('list', { name: '객체 목록' })).toContainText('돌출 1');

    // 크기 조정 (선택: 빼기 결과) → 1.5 배
    await page.locator('[data-object-id="cut_1"]').click();
    await page.getByTestId('cmd-scale').click();
    await expect.poll(async () => (await sources(page)).pattern_1?.max[2], { timeout: 20_000 }).toBe(30);
    await page.getByTestId('scale-z').fill('1');
    await page.getByTestId('scale-z').press('Enter');
    await expect.poll(async () => (await sources(page)).pattern_1?.max[2], { timeout: 20_000 }).toBe(20);

    // 새 스케치를 각도 평면으로 바꾸고 구성선 추가
    await page.getByRole('tab', { name: '스케치' }).click();
    await page.getByRole('button', { name: '정면' }).first().click();
    await page.getByTestId('cmd-sketch').click();
    await page.getByTestId('sketch-plane').selectOption('angled');
    await expect(page.getByTestId('angled-angle')).toHaveValue('30');
    await page.getByTestId('cmd-line').click();
    await expect(page.getByTestId('line-line1-p1-x')).toHaveValue('20');

    // 직교 보기 전환
    await page.getByRole('tab', { name: '보기' }).click();
    await page.getByTestId('cmd-projection').click();
    await expect(page.getByTestId('cmd-projection')).toHaveAttribute('aria-pressed', 'true');
    await expect(page.getByTestId('cmd-projection')).toContainText('직교');
    await page.keyboard.press('Control+7');
    await page.screenshot({ path: `test-results/v7-${engine}.png` });
    await page.getByTestId('cmd-projection').click();
    await expect(page.getByTestId('cmd-projection')).toContainText('원근');
  });
}
