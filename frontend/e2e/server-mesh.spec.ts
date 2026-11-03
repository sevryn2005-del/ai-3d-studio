import { expect, test } from '@playwright/test';

const sources = (page: import('@playwright/test').Page) =>
  page.evaluate(() => window.__AI3D_DEV__!.meshSources());

test('서버(CadQuery) 메시가 표시되고, 높이 50 변경이 실제 형상에 반영된다', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);

  // 처음엔 미리보기 → 서버 계산 완료 후 서버 메시로 교체
  await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe('server');
  const first = (await sources(page)).box_1!;
  expect(first.min).toEqual([-10, -10, 0]);
  expect(first.max).toEqual([10, 10, 20]);

  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');

  // 화면에 그려진 실제 지오메트리의 높이가 50mm
  await expect.poll(async () => (await sources(page)).box_1?.max[2]).toBe(50);
  await expect.poll(async () => (await sources(page)).box_1?.source).toBe('server');

  // 실행 취소 → 캐시된 서버 메시를 즉시 재사용
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await sources(page)).box_1).toMatchObject({ source: 'server', max: [10, 10, 20] });
});

test('곡면 도형도 서버 메시로 표시된다', async ({ page }) => {
  await page.goto('/');
  for (const label of ['원통', '구', '원뿔']) await page.getByRole('button', { name: `+ ${label}` }).click();
  await expect
    .poll(async () => Object.values(await sources(page)).map((s) => s.source), { timeout: 20_000 })
    .toEqual(['server', 'server', 'server', 'server']);
  const s = await sources(page);
  const sphere = s.sphere_1!;
  expect(sphere.max[2]! - sphere.min[2]!).toBeCloseTo(20, 1);
});
