/** 분해도 (형식 v41): 부품 둘 → 자동 분해 → 화면에서 벌어짐(설계 위치 그대로) → 부품 이동량 바꾸기 → 끄기 → 저장 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('분해도: 자동 분해·부품별 이동·보기 끄기, 설계 위치·저장', async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  const src = async () => await page.evaluate(() => window.__AI3D_DEV__!.meshSources());
  await expect.poll(async () => (await src()).box_1?.source, { timeout: 20_000 }).toBe('server');
  await page.evaluate(() => window.__AI3D_DEV__!.dispatch({ type: 'create_box', id: 'lid', width: 20, depth: 20, height: 4, position: [0, 0, 20] }));
  await expect.poll(async () => (await src()).lid?.source, { timeout: 20_000 }).toBe('server');
  await page.getByRole('tab', { name: '조립품' }).click();
  await page.getByTestId('cmd-explode').click();
  await page.getByTestId('explode-auto').click();
  await expect(page.getByTestId('explode-on')).toBeChecked();
  // 가운데 z = 10 → 큐브 원점 z0 은 −10, 뚜껑 z20 은 +10 더 벌어진다
  await expect.poll(async () => (await src()).lid?.min[2]).toBeCloseTo(30, 3);
  expect((await src()).box_1!.min[2]).toBeCloseTo(-10, 3);
  const pos = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects.find((o) => o.id === 'lid')!.position;
  expect(pos).toEqual([0, 0, 20]); // 설계 위치는 그대로
  // 뚜껑만 X 로 더
  await page.locator('[data-object-id="lid"]').click();
  await page.getByTestId('explode-x').fill('25');
  await page.getByTestId('explode-x').press('Enter');
  await expect.poll(async () => (await src()).lid?.min[0]).toBeCloseTo(15, 3);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(43);
  expect(saved.model.explode).toEqual([
    { id: 'box_1', offset: [0, 0, -10] },
    { id: 'lid', offset: [25, 0, 10] },
  ]);
  await page.getByTestId('explode-on').uncheck();
  await expect.poll(async () => (await src()).lid?.min).toEqual([-10, -10, 20]);
});
