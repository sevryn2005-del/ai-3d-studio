/**
 * 스케치 화면 (종이·격자·스냅): 스케치 중에만 종이·원점·설정 막대가 보이고,
 * 점 스냅(끝점)·정렬 스냅(수평)이 격자 스냅을 꺼도 정확한 좌표를 준다. 설정은 이 브라우저에 남는다.
 */
import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('스케치 종이·격자·끝점 스냅·수평 정렬·설정 유지', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-design').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect(page.getByTestId('sketch-options')).toHaveCount(0); // 스케치 전에는 없음
  await page.getByTestId('guide-start-sketch').click();
  await page.locator('[data-plane="XY"]').click();
  await expect(page.getByTestId('sketch-options')).toBeVisible();
  await expect(page.getByTestId('sketch-grid-scale')).toContainText('칸');

  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  const drag = async (from: [number, number], to: [number, number]) => {
    const a = await at(...from);
    const b = await at(...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
  };
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByRole('button', { name: /^사각형/ }).click();
  await page.waitForTimeout(500); // 수직 보기 카메라 이동
  await drag([-20, -10], [20, 10]);

  // 격자 스냅을 끄고 모서리 근처를 가리키면 끝점에 정확히 붙는다
  await page.getByTestId('sketch-opt-gridSnap').click();
  await expect(page.getByTestId('sketch-opt-gridSnap')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: /^원/ }).first().click();
  const near = await at(19.7, 10.3);
  await page.mouse.move(near.x, near.y, { steps: 3 });
  await expect(page.getByTestId('snap-hud')).toHaveAttribute('data-snap', 'endpoint');
  await expect(page.getByTestId('snap-hud')).toContainText('끝점');
  // 원: 모서리(끝점)에서 시작
  await drag([19.7, 10.3], [25.3, 10.4]);
  const sketches = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches;
  expect(sketches[0]!.entities.find((e) => e.type === 'circle')!.center).toEqual([20, 10]);

  // 사각형 윗변·원 중심과 같은 높이(v = 10)로 가면 수평 정렬 안내
  const side = await at(-28.4, 9.7);
  await page.mouse.move(side.x, side.y, { steps: 3 });
  await expect(page.getByTestId('snap-hud')).toContainText('수평 정렬');
  await expect(page.getByTestId('snap-hud')).toContainText('10');

  // 종이 끄기 → 새로 고침 후에도 유지
  await page.getByTestId('sketch-opt-paper').click();
  await expect(page.getByTestId('sketch-opt-paper')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ai3d.sketchView') ?? '{}'))).toMatchObject({ paper: false, gridSnap: false });

  // 그리기를 끝내고 스케치 선택을 풀면 종이·막대가 사라진다
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sketch-options')).toHaveCount(0);
});
