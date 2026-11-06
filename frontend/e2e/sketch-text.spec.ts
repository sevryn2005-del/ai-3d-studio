/**
 * 스케치 텍스트: 스케치 속성 "텍스트"에 글자를 넣으면 글꼴 윤곽(다각형) + 영역 하나 → 영역 돌출 = 양각 글자.
 * 글꼴은 프로그램에 들어 있다 (인터넷 없이). 실행 취소 1번
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const sketches = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene().sketches);
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => window.__AI3D_DEV__!.dispatch(c), cmd);

test('스케치 텍스트 → 영역 돌출 (한글), 없는 글자 안내, 실행 취소', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBeTruthy();
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await dispatch(page, { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } });
  await page.locator('[data-sketch-id="s"]').click();

  // 글꼴에 없는 글자는 넣지 않고 알려준다
  await page.getByTestId('sketch-text-input').fill('똠');
  await page.getByTestId('sketch-text-add').click();
  await expect(page.getByRole('alert')).toContainText('글꼴에 없는 글자');

  await page.getByTestId('sketch-text-input').fill('AI 3D 한글');
  await page.getByTestId('sketch-text-size').fill('10');
  await page.getByTestId('sketch-text-size').press('Enter');
  await page.getByTestId('sketch-text-add').click();
  await expect(page.getByTestId('notice')).toContainText('text_region1');
  const ents = (await sketches(page)).find((s) => s.id === 's')!.entities;
  expect(ents.filter((e) => e.type === 'polygon').length).toBeGreaterThan(8);
  expect(ents.filter((e) => e.type === 'region')).toHaveLength(1);

  await page.getByTestId('extrude-text_region1').click();
  const width = async () => {
    const e = (await sources(page)).extrude_1;
    return e ? e.max[0]! - e.min[0]! : 0;
  };
  await expect.poll(width, { timeout: 30_000 }).toBeGreaterThan(40); // 글자 9자 폭
  const e = (await sources(page)).extrude_1!;
  expect(e.max[1]! - e.min[1]!).toBeGreaterThan(7);
  expect(e.max[1]! - e.min[1]!).toBeLessThan(11);
  expect((e.max[0]! + e.min[0]!) / 2).toBeCloseTo(0, 0);

  await page.keyboard.press('Control+z'); // 돌출
  await page.keyboard.press('Control+z'); // 텍스트
  await expect.poll(async () => (await sketches(page)).find((s) => s.id === 's')!.entities.length).toBe(0);
});
