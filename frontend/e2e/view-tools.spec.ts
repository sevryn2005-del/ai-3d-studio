/** 보기·분석 도구: 표시 모드, 단면, 측정, 질량 특성, 이미지 저장 (설계 원본은 바뀌지 않는다) */
import { expect, test, type Page } from '@playwright/test';

const scene = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());
const at = (page: Page, x: number, y: number, z: number) => page.evaluate(([x, y, z]) => window.__AI3D_DEV__!.project(x!, y!, z!), [x, y, z]);

test('표시 모드·단면·측정·질량 특성·이미지 저장', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect.poll(async () => (await page.evaluate(() => window.__AI3D_DEV__!.meshSources())).box_1?.source, { timeout: 20_000 }).toBe('server');
  const before = await scene(page);
  await page.getByRole('tab', { name: '보기' }).click();

  for (const id of ['shaded', 'wireframe', 'xray', 'shadedEdges']) {
    await page.getByTestId(`display-${id}`).click();
    await expect(page.getByTestId(`display-${id}`)).toHaveAttribute('aria-pressed', 'true');
  }

  // 질량 특성: 기본 큐브 20×20×20 = 8000 mm³, PLA 1.24 → 9.92 g
  await page.getByTestId('cmd-mass').click();
  await expect(page.getByTestId('mass-volume')).toHaveText('8000 mm³');
  await expect(page.getByTestId('mass-grams')).toHaveText('9.92 g');
  await page.getByLabel('재료').selectOption('al');
  await expect(page.getByTestId('mass-grams')).toHaveText('21.6 g');
  await page.getByTestId('cmd-mass').click();

  // 단면: 켜고 위치를 바꾸고 끈다
  await page.getByTestId('cmd-section').click();
  await expect(page.getByRole('group', { name: '단면 보기' })).toBeVisible();
  await page.getByTestId('section-offset').fill('5');
  await page.getByTestId('cmd-section').click();
  await expect(page.getByRole('group', { name: '단면 보기' })).toBeHidden();

  // 측정: 윗면 두 점 클릭 → 거리
  await page.getByTestId('cmd-measure').click();
  for (const [x, y] of [[-6, -6], [6, -6]] as const) {
    const p = await at(page, x, y, 20);
    await page.mouse.click(p.x, p.y);
  }
  await expect(page.getByTestId('measure-readout')).toContainText(/거리 1[12]\.\d* mm|거리 12 mm/);
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('measure-readout')).toBeHidden();

  // 이미지 저장 (PNG 다운로드)
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByTestId('cmd-screenshot').click()]);
  expect(download.suggestedFilename()).toMatch(/\.png$/);

  expect((await scene(page)).revision).toBe(before.revision);
});

test('구배 분석: 빼는 방향 Z → 윗면 양·아랫면 음·옆면 구배 부족, 축 바꾸기·회전한 객체, 끄기 (원본 그대로)', async ({ page }, info) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  const box = async () => (await page.evaluate(() => window.__AI3D_DEV__!.meshSources())).box_1;
  await expect.poll(async () => (await box())?.source, { timeout: 20_000 }).toBe('server');
  const rev = (await scene(page)).revision;
  await page.getByRole('tab', { name: '보기' }).click();
  await page.getByTestId('cmd-draft-analysis').click();
  await expect(page.getByTestId('draft-panel')).toBeVisible();
  // 큐브 20: 윗면 400 · 아랫면 400 · 옆면 1600 mm²
  await expect.poll(async () => (await box())?.draft).toEqual({ positive: 400, negative: 400, insufficient: 1600 });
  await expect(page.getByTestId('draft-insufficient')).toContainText('67%');
  await page.screenshot({ path: info.outputPath('draft.png') });
  await page.getByTestId('draft-flip').click();
  await expect(page.getByTestId('draft-axis-z')).toHaveText('−Z');
  // 객체를 X 축으로 30° 돌리면 옆면 두 개가 ±30° 구배 → 한계 1° 넘음
  await page.evaluate(() =>
    window.__AI3D_DEV__!.dispatch({ type: 'set_transform', target: 'box_1', rotation: [30, 0, 0] }),
  );
  await expect.poll(async () => (await box())?.draft?.insufficient, { timeout: 20_000 }).toBeCloseTo(800, 3);
  await page.getByTestId('draft-angle').fill('40');
  await expect.poll(async () => (await box())?.draft?.insufficient).toBeCloseTo(1600, 3);
  await page.getByTestId('cmd-draft-analysis').click();
  await expect(page.getByTestId('draft-panel')).toHaveCount(0);
  await expect.poll(async () => (await box())?.draft).toBeNull();
  expect((await scene(page)).revision).toBe(rev + 1); // 회전 명령 하나만
});
