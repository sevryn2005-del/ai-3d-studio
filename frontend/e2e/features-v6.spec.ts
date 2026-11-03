/**
 * 형식 v6 피처를 실제 화면 조작으로 (두 엔진): 쉘 → 구멍 → 선형 패턴 → 억제 → 색·숨기기 → 대칭 → 저장 형식
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const scene = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());

for (const engine of ['server', 'browser'] as const) {
  test(`쉘·구멍·패턴·억제·외관·대칭 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    const plain = (await sources(page)).box_1!;

    // 쉘: 피처 탭 → 쉘 (윗면 열림, 기본 두께) → 외형 그대로, 메시가 바뀜
    await page.getByTestId('cmd-shell').click();
    await expect(page.getByTestId('shell-thickness')).toHaveValue('2');
    await expect(page.getByTestId('shell-open-top')).toBeChecked();
    await expect.poll(async () => (await sources(page)).box_1?.vertices, { timeout: 20_000 }).toBeGreaterThan(plain.vertices);
    expect((await sources(page)).box_1!.max).toEqual([10, 10, 20]);

    // 두께가 너무 크면 거부되고 값이 되돌아간다
    await page.getByTestId('shell-thickness').fill('10');
    await page.getByTestId('shell-thickness').press('Enter');
    await expect(page.getByRole('alert')).toContainText('너무 큽니다');
    await expect(page.getByTestId('shell-thickness')).toHaveValue('2');
    await page.getByTestId('shell-thickness').fill('0'); // 쉘 제거
    await page.getByTestId('shell-thickness').press('Enter');

    // 구멍 가공: 윗면 중심 관통 → 빼기 결과로 바뀜
    await page.getByTestId('cmd-hole').click();
    await expect.poll(async () => (await sources(page)).cut_1?.source, { timeout: 20_000 }).toBe(engine);
    await expect(page.locator('.object-list')).toContainText('구멍 Ø5');

    // 선형 패턴 (선택: 빼기 결과) → X 로 3개, 25mm 간격
    await page.getByTestId('cmd-linear').click();
    await expect.poll(async () => (await sources(page)).pattern_1?.max[0], { timeout: 20_000 }).toBe(60);
    await page.getByTestId('pattern-count').fill('2');
    await page.getByTestId('pattern-count').press('Enter');
    await expect.poll(async () => (await sources(page)).pattern_1?.max[0], { timeout: 20_000 }).toBe(35);

    // 억제: 계산에서 빠져 메시가 사라진다 → 해제하면 돌아온다
    await page.getByTestId('toggle-suppressed').check();
    await expect.poll(async () => Object.keys(await sources(page))).not.toContain('pattern_1');
    await expect(page.locator('.object-list .suppressed')).toContainText('선형 패턴 1');
    await page.getByTestId('toggle-suppressed').uncheck();
    await expect.poll(async () => (await sources(page)).pattern_1?.source, { timeout: 20_000 }).toBe(engine);

    // 색·숨기기: 형상 계산과 무관 (원본만 바뀜)
    await page.getByRole('button', { name: '색 #e5534b' }).click();
    await expect(page.locator('.object-list .color-dot')).toHaveCount(1);
    await page.getByTestId('toggle-hidden').check();
    await expect(page.locator('.object-list')).toContainText('(숨김)');
    await page.getByTestId('toggle-hidden').uncheck();

    // 패턴 삭제 → 원본(빼기 결과)은 남는다, 대칭 복사
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    await expect(page.locator('.object-list')).not.toContainText('선형 패턴');
    await page.locator('[data-object-id="cut_1"]').click();
    await page.getByTestId('cmd-mirror').click();
    await expect.poll(async () => (await sources(page)).pattern_1?.min[0], { timeout: 20_000 }).toBe(-10);
    await page.keyboard.press('Control+7');
    await page.screenshot({ path: `test-results/v6-dark-${engine}.png` });
    const s = await scene(page);
    expect(s.objects.map((o) => o.id).sort()).toEqual(['box_1', 'cut_1', 'hole_1', 'pattern_1']);
  });
}
