/**
 * 스케치 지능형 치수 (D): 변 클릭 → 빈 곳 = 길이 / 원 = 지름 / 점 두 개 = 거리 / 변 두 개 = 각도 → 값 입력 Enter,
 * 화면 치수 숫자 더블클릭 → 고치기, 실행 취소 1번.
 */
import { expect, test, type Page } from '@playwright/test';

type P = [number, number];
const pts = async (page: Page) =>
  (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches.find((s) => s.id === 's')!.entities.find((e) => e.id === 'p')!.points as P[];
const click = async (page: Page, [x, y]: P) => {
  const s = await page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  await page.mouse.click(s.x, s.y);
};
const mid = (a: P, b: P): P => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
const dist = (a: P, b: P) => Math.hypot(b[0] - a[0], b[1] - a[1]);

test('스케치 지능형 치수: 길이·지름·거리·각도·더블클릭 고치기', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.evaluate(() => {
    const d = window.__AI3D_DEV__!;
    d.dispatch({ type: 'delete_object', target: 'box_1' });
    d.dispatch({ type: 'create_sketch', id: 's' });
    d.dispatch({ type: 'add_polygon', sketch: 's', id: 'p', points: [[0, 0], [40, 0], [40, 20], [0, 20]] });
    d.dispatch({ type: 'add_circle', sketch: 's', id: 'c', center: [20, 35], diameter: 10 });
  });
  await page.locator('[data-sketch-id="s"]').click();
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByTestId('cmd-dimension').click();
  await expect(page.getByTestId('cmd-dimension')).toHaveAttribute('aria-pressed', 'true');

  // 1. 아래 변 → 빈 곳: 길이 40 → 50
  let p = await pts(page);
  await click(page, mid(p[0]!, p[1]!));
  await click(page, [20, -12]);
  await expect(page.getByTestId('dim-value')).toHaveValue('40');
  await page.getByTestId('dim-value').fill('50');
  await page.getByTestId('dim-value').press('Enter');
  await expect.poll(async () => { const q = await pts(page); return Math.round(dist(q[0]!, q[1]!) * 1000) / 1000; }).toBe(50);

  // 2. 원 → 지름 10 → 14 (화면 치수 기호에 Ø14)
  await click(page, [25, 35]);
  await expect(page.getByTestId('dim-value')).toHaveValue('10');
  await page.getByTestId('dim-value').fill('14');
  await page.getByTestId('dim-value').press('Enter');
  await expect(page.getByTestId('sketch-dim-label').filter({ hasText: 'Ø14' })).toHaveCount(1);

  // 3. 점 두 개 (왼쪽 아래 p0 · 왼쪽 위 p3) → 거리 25
  p = await pts(page);
  await click(page, p[0]!);
  await click(page, p[3]!);
  await page.getByTestId('dim-value').fill('25');
  await page.getByTestId('dim-value').press('Enter');
  await expect.poll(async () => { const q = await pts(page); return Math.round(dist(q[0]!, q[3]!) * 1000) / 1000; }).toBe(25);

  // 4. 변 두 개 (아래 e0 · 왼쪽 e3) → 각도 구속 (지금 90° 근처) → 80
  p = await pts(page);
  await click(page, mid(p[0]!, p[1]!));
  await click(page, mid(p[3]!, p[0]!));
  await page.getByTestId('dim-value').fill('80');
  await page.getByTestId('dim-value').press('Enter');
  await expect
    .poll(async () => (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches[0]!.constraints.map((c) => c.type))
    .toEqual(['length', 'distance', 'angle']);

  // 5. 도구를 끄고 화면 치수 숫자 "50" 더블클릭 → 45
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('cmd-dimension')).toHaveAttribute('aria-pressed', 'false');
  await page.getByTestId('sketch-dim-label').filter({ hasText: /^50$/ }).dblclick();
  await expect(page.getByTestId('dim-value')).toHaveValue('50');
  await page.getByTestId('dim-value').fill('45');
  await page.getByTestId('dim-value').press('Enter');
  await expect.poll(async () => { const q = await pts(page); return Math.round(dist(q[0]!, q[1]!) * 1000) / 1000; }).toBe(45);
  await page.keyboard.press('Control+z');
  await expect.poll(async () => { const q = await pts(page); return Math.round(dist(q[0]!, q[1]!) * 1000) / 1000; }).toBe(50);
});
