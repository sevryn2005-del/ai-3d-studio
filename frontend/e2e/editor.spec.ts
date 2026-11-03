import { expect, test, type Page } from '@playwright/test';

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.waitForTimeout(300); // 첫 프레임 렌더 대기
}

const project = (page: Page, x: number, y: number, z: number) =>
  page.evaluate(([x, y, z]) => window.__AI3D_DEV__!.project(x!, y!, z!), [x, y, z]);

const field = (page: Page, legend: string, label: string) =>
  page.locator('fieldset', { hasText: legend }).getByLabel(label, { exact: true });

test('속성 패널에서 높이를 50mm로 바꾸고 실행 취소/다시 실행', async ({ page }) => {
  await ready(page);
  const h = page.getByTestId('param-height');
  await expect(h).toHaveValue('20');
  await h.fill('50');
  await h.press('Enter');
  await expect(h).toHaveValue('50');
  await expect(page.locator('.object-list')).toContainText('20×20×50');

  await page.keyboard.press('Control+z');
  await expect(h).toHaveValue('20');
  await page.keyboard.press('Control+Shift+z');
  await expect(h).toHaveValue('50');
});

test('범위를 벗어난 치수는 거부되고 오류가 표시된다', async ({ page }) => {
  await ready(page);
  const h = page.getByTestId('param-height');
  await h.fill('-3');
  await h.press('Enter');
  await expect(h).toHaveValue('20');
  await expect(page.getByRole('alert')).toContainText('0.1mm 이상');
});

test('이동 기즈모 X축 드래그 → 1mm 스냅된 위치로 명령 1회 기록', async ({ page }) => {
  await ready(page);
  const xField = field(page, '위치', 'X');
  await expect(xField).toHaveValue('0');

  // 기즈모 원점(박스 바닥 중심)과 +X 방향의 화면 좌표
  const o = await project(page, 0, 0, 0);
  const px = await project(page, 1, 0, 0);
  const len = Math.hypot(px.x - o.x, px.y - o.y);
  const dir = { x: (px.x - o.x) / len, y: (px.y - o.y) / len };

  // X 화살표 손잡이를 잡고 같은 방향으로 끈다
  const grab = { x: o.x + dir.x * 60, y: o.y + dir.y * 60 };
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + dir.x * 120, grab.y + dir.y * 120, { steps: 12 });
  await page.mouse.up();

  // 명령 반영 후 React 가 다시 그릴 때까지 자동 재시도하며 기다린다 (inputValue() 즉시 읽기는 경쟁 상태)
  await expect(xField).not.toHaveValue('0');
  const x = Number(await xField.inputValue());
  expect(x).toBeGreaterThan(5);
  expect(Number.isInteger(x)).toBe(true); // 1mm 스냅
  await expect(field(page, '위치', 'Y')).toHaveValue('0');
  await expect(field(page, '위치', 'Z')).toHaveValue('0');
  await expect(page.locator('.props')).toBeVisible(); // 드래그 후에도 선택 유지

  await page.keyboard.press('Control+z'); // 드래그 1회 = 히스토리 1단계
  await expect(xField).toHaveValue('0');
});

test('W/E/S/F 단축키와 빈 공간 클릭', async ({ page }) => {
  await ready(page);
  const toolbar = page.getByRole('toolbar', { name: '뷰포트 도구' });
  await page.keyboard.press('e');
  await expect(toolbar.getByRole('button', { name: /회전/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('w');
  await expect(toolbar.getByRole('button', { name: /이동/ })).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('s');
  await expect(toolbar.getByRole('button', { name: /스냅/ })).toHaveText(/끔/);

  // 화면 맞춤 후 큐브가 뷰포트 중앙 근처에 온다
  await page.keyboard.press('f');
  await page.waitForTimeout(200);
  const c = await project(page, 0, 0, 10);
  const box = (await page.locator('.viewport canvas').boundingBox())!;
  expect(Math.abs(c.x - (box.x + box.width / 2))).toBeLessThan(5);
  expect(Math.abs(c.y - (box.y + box.height / 2))).toBeLessThan(5);

  await page.mouse.click(box.x + 40, box.y + box.height - 60);
  await expect(page.locator('.props')).toHaveCount(0);
});

test('원통·구·원뿔 추가 → 원통 반지름 수정 → 잘못된 파라미터는 패널에 없음', async ({ page }) => {
  await ready(page);
  for (const label of ['원통', '구', '원뿔']) {
    await page.getByRole('button', { name: `+ ${label}` }).click();
  }
  const list = page.locator('.object-list li');
  await expect(list).toHaveCount(4);
  await expect(list.nth(1)).toContainText('Ø20×20');
  await expect(list.nth(2)).toContainText('Ø20');
  await expect(list.nth(3)).toContainText('Ø20→Ø0×20');

  // 마지막으로 만든 원뿔이 선택되어 있다 → 원통 선택
  await list.nth(1).getByRole('button').click();
  await expect(page.locator('.props')).toContainText('유형: 원통');
  await expect(page.getByTestId('param-width')).toHaveCount(0);
  const r = page.getByTestId('param-radius');
  await r.fill('8');
  await r.press('Enter');
  await expect(list.nth(1)).toContainText('Ø16×20');
});
