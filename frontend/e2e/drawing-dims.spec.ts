/**
 * 도면 사용자 치수 (형식 v17, 브라우저 엔진): 꼭짓점 클릭으로 수평·수직 치수, 원 클릭으로 지름 →
 * 모델 폭을 바꾸면 치수가 따라감 → 간격 바꾸기·지우기 → 저장된 설정 (창을 다시 열어도 남음).
 */
import { expect, test, type Page } from '@playwright/test';

const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => window.__AI3D_DEV__!.dispatch(c), cmd);

/** 보기 좌표 (mm) → 화면 좌표: 고르기 층의 배치 정보로 */
async function clickView(page: Page, view: 'front' | 'top' | 'right', x: number, y: number) {
  const pick = page.getByTestId('drawing-pick');
  const placements = JSON.parse((await pick.getAttribute('data-placements'))!) as Record<string, { at: number[]; bounds: number[]; scale: number }>;
  const [W, H] = (await pick.getAttribute('data-paper'))!.split(',').map(Number) as [number, number];
  const pl = placements[view]!;
  const px = pl.at[0]! + (x - pl.bounds[0]!) * pl.scale;
  const py = pl.at[1]! + (y - pl.bounds[1]!) * pl.scale;
  const box = (await pick.boundingBox())!;
  await page.mouse.move(box.x + (px / W) * box.width, box.y + ((H - py) / H) * box.height);
  await page.mouse.click(box.x + (px / W) * box.width, box.y + ((H - py) / H) * box.height);
}

test('도면 치수 직접 추가·따라가기·지우기', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await dispatch(page, { type: 'create_box', id: 'b', width: 40, depth: 20, height: 10 });
  await dispatch(page, { type: 'hole', id: 'h', target: 'b', face: 'top', at: [10, 0], diameter: 6, depth: 10 });
  await page.getByRole('tab', { name: '도면' }).click();
  await page.getByTestId('cmd-drawing').click();
  await expect(page.getByTestId('drawing-sheet')).toBeVisible({ timeout: 40_000 });
  await page.getByTestId('drawing-dims').uncheck(); // 자동 치수 없이 직접

  // 1. 수평: 정면도 아래 두 모서리 (조금 빗나가도 꼭짓점에 붙음) → 아래쪽에 치수선
  await page.getByTestId('dim-mode-horizontal').click();
  await clickView(page, 'front', -19.7, 0.3);
  await clickView(page, 'front', 19.8, 0.2);
  await clickView(page, 'front', 0, -6);
  await expect(page.getByTestId('dim-value-dim1')).toHaveText('40');

  // 2. 수직: 왼쪽 위·아래 모서리
  await page.getByTestId('dim-mode-vertical').click();
  await clickView(page, 'front', -20, 0);
  await clickView(page, 'front', -20, 10);
  await clickView(page, 'front', -26, 5);
  await expect(page.getByTestId('dim-value-dim2')).toHaveText('10');

  // 3. 지름: 평면도의 구멍 가장자리
  await page.getByTestId('dim-mode-diameter').click();
  await clickView(page, 'top', 13, 0);
  await expect(page.getByTestId('dim-value-dim3')).toHaveText('Ø6');
  // Esc: 치수 모드만 끝내고 창은 그대로
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('drawing-pick')).toHaveAttribute('data-mode', '');
  await expect(page.getByTestId('drawing-window')).toBeVisible();
  const sheet = page.getByTestId('drawing-sheet');
  for (const t of ['40', '10', 'Ø6']) await expect(sheet.locator('text', { hasText: new RegExp(`^${t}$`) })).toHaveCount(1);

  // 4. 모델 폭 40 → 60: 치수가 따라간다 (구멍 지름은 그대로)
  await dispatch(page, { type: 'set_params', target: 'b', params: { width: 60 } });
  await expect(page.getByTestId('dim-value-dim1')).toHaveText('60', { timeout: 40_000 });
  await expect(page.getByTestId('dim-value-dim3')).toHaveText('Ø6');

  // 5. 간격 바꾸기·지우기, 창을 닫았다 열어도 남는다 (모델에 저장)
  await page.getByTestId('dim-offset-dim1').fill('-12');
  await page.getByTestId('dim-offset-dim1').press('Enter');
  await page.getByTestId('dim-delete-dim2').click();
  await expect(page.getByTestId('dim-row-dim2')).toHaveCount(0);
  await page.getByTestId('drawing-close').click();
  await page.getByTestId('cmd-drawing').click();
  await expect(page.getByTestId('dim-offset-dim1')).toHaveValue('-12', { timeout: 40_000 });
  await expect(page.getByTestId('dim-value-dim1')).toHaveText('60');
});
