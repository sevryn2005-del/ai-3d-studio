/**
 * 조립품 (형식 v11, 두 엔진): 부품 삽입(.ai3d) → 메이트(일치) → 치수 변경을 따라감 → 간섭 검사 → 부품표.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const scene = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());
const PART = fileURLToPath(new URL('../../shared/samples/project-v2-plate.ai3d', import.meta.url));

for (const engine of ['server', 'browser'] as const) {
  test(`부품 삽입·메이트·간섭 검사·부품표 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    test.setTimeout(90_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.addInitScript(() => {
      for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
    });
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);

    // 1. 부품 삽입: v2 기준 판 (구버전 파일도 마이그레이션되어 들어간다)
    await page.getByRole('tab', { name: '조립품' }).click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('cmd-insert-part').click()]);
    await chooser.setFiles(PART);
    // 넣은 부품의 최상위 객체 = 마지막에 추가된 객체 (v2 판: 돌출 − 구멍 = 빼기)
    await expect.poll(async () => (await scene(page)).objects.length, { timeout: 10_000 }).toBeGreaterThan(1);
    const plateId = (await scene(page)).objects.at(-1)!.id;
    await expect.poll(async () => (await sources(page))[plateId]?.source, { timeout: 30_000 }).toBe(engine);

    // 2. 메이트: 큐브 윗면(기준) ↔ 판 바닥(움직일 부품) 일치 → 판이 큐브 위(높이 20)로
    await page.getByTestId('cmd-mate').click();
    const panel = page.getByTestId('mate-panel');
    await panel.getByTestId('mate-type').selectOption('coincident');
    await panel.getByTestId('mate-a').selectOption('box_1.top');
    const bottom = await panel.getByTestId('mate-b').locator('option', { hasText: '· start' }).first().getAttribute('value');
    await panel.getByTestId('mate-b').selectOption(bottom!);
    await panel.getByTestId('mate-ok').click();
    await expect(panel.getByRole('list', { name: '메이트 목록' })).toContainText('일치');
    await expect.poll(async () => (await sources(page))[plateId]?.min[2] ?? -1, { timeout: 30_000 }).toBeCloseTo(20, 3);
    await expect(panel.getByTestId('mate-dof')).toContainText('자유도 3');

    // 3. 큐브 높이 20 → 35: 판이 따라 올라간다
    await page.locator('[data-object-id="box_1"]').click();
    await page.getByTestId('param-height').fill('35');
    await page.getByTestId('param-height').press('Enter');
    await expect.poll(async () => (await sources(page))[plateId]?.min[2] ?? -1, { timeout: 30_000 }).toBeCloseTo(35, 3);

    // 4. 간섭 검사: 큐브를 관통하는 원통을 넣으면 그 쌍이 나온다
    await page.evaluate((cmd) => window.__AI3D_DEV__!.dispatch(cmd), { type: 'create_cylinder', id: 'rod', radius: 2, height: 60, position: [0, 0, -5] });
    await page.getByTestId('cmd-interference').click();
    await page.getByTestId('interference-run').click();
    const result = page.getByTestId('interference-result');
    await expect(result).toContainText('↔', { timeout: 30_000 });
    await expect(result).toContainText('큐브');
    await expect(result).not.toContainText('간섭 없음');

    // 5. 부품표: 큐브·판·원통 3줄, CSV 저장
    await page.getByTestId('cmd-bom').click();
    const bom = page.getByTestId('bom-panel');
    await expect(bom.locator('tbody tr')).toHaveCount(3);
    const [download] = await Promise.all([page.waitForEvent('download'), bom.getByTestId('bom-csv').click()]);
    const csv = readFileSync((await download.path())!, 'utf8');
    expect(csv).toContain('번호,이름,종류,크기,수량');
    expect(csv.trim().split('\n')).toHaveLength(4);
  });
}
