/** 렌더 (1단계): 보기 탭 → 렌더 패널 → 640×360 흰 배경 → 미리보기(크기·가운데에 모델) → PNG 저장, 투명 배경 → 구석 알파 0 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

/** 미리보기 그림의 (x, y) 픽셀 [r, g, b, a] */
const pixel = (page: Page, x: number, y: number) =>
  page.getByTestId('render-preview').evaluate(
    (img: HTMLImageElement, [x, y]) => {
      const c = document.createElement('canvas');
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const g = c.getContext('2d')!;
      g.drawImage(img, 0, 0);
      return [...g.getImageData(x!, y!, 1, 1).data];
    },
    [x, y],
  );

test('렌더: 크기·배경·그림자 → 미리보기 → PNG 저장', async ({ page }, info) => {
  test.setTimeout(120_000);
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect.poll(async () => (await page.evaluate(() => window.__AI3D_DEV__!.meshSources())).box_1?.source, { timeout: 20_000 }).toBe('server');
  await page.getByRole('tab', { name: '보기' }).click();
  await page.getByTestId('cmd-render').click();
  await page.getByTestId('render-size').selectOption('small');
  await page.getByTestId('render-quality').selectOption('fast');
  await page.getByTestId('render-start').click();
  await expect(page.getByTestId('render-info')).toContainText('640 × 360', { timeout: 60_000 });
  await expect.poll(() => page.getByTestId('render-preview').evaluate((i: HTMLImageElement) => i.naturalWidth)).toBe(640);
  // 흰 배경 구석 = 흰색, 가운데(모델) = 흰색 아님
  expect((await pixel(page, 2, 2)).slice(0, 3)).toEqual([255, 255, 255]);
  const center = await pixel(page, 320, 180);
  expect(center[0]! + center[1]! + center[2]!).toBeLessThan(720);
  await page.getByTestId('render-preview').screenshot({ path: info.outputPath('render.png') });
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByTestId('render-save').click()]);
  const buf = readFileSync((await dl.path())!);
  expect(buf.subarray(1, 4).toString()).toBe('PNG');
  expect(dl.suggestedFilename()).toBe('제목 없음 렌더.png');
  // 투명 배경: 구석 알파 0
  await page.getByTestId('render-background').selectOption('transparent');
  await page.getByTestId('render-shadows').uncheck();
  await page.getByTestId('render-start').click();
  await expect.poll(async () => (await pixel(page, 2, 2))[3], { timeout: 60_000 }).toBe(0);
  // 렌더 뒤 화면은 그대로 (객체 선택·편집 가능)
  await expect(page.getByRole('alert')).toHaveCount(0);
});
