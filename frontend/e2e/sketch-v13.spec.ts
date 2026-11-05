/**
 * 형식 v13 스케치 보강 화면 흐름 (브라우저 엔진): 사각형 → 다각형 바꾸기 → 변을 호로 → 꼭짓점 하나만 필렛 → 대칭 구속.
 * 모양 값은 공유 픽스처(sketch-arc-edge·sketch-rect-to-polygon-fillet)가 세 엔진에서 검사한다.
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => window.__AI3D_DEV__!.dispatch(c), cmd);

test('사각형 → 다각형 → 호 변 → 꼭짓점 필렛 → 대칭 구속', async ({ page }) => {
  test.setTimeout(90_000);
  await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe('browser');
  await page.getByRole('button', { name: '삭제', exact: true }).click();

  for (const c of [
    { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
    { type: 'add_rectangle', sketch: 's', id: 'r', center: [0, 0], width: 20, height: 20 },
    { type: 'extrude', id: 'e', sketch: 's', profile: 'r', distance: 5 },
  ])
    await dispatch(page, c);
  await expect.poll(async () => (await sources(page)).e?.max[0] ?? 0, { timeout: 20_000 }).toBeCloseTo(10, 3);

  // 1. 사각형 → 다각형 (같은 id, 꼭짓점 편집이 나타난다)
  await page.locator('[data-sketch-id="s"]').click();
  await page.getByTestId('to-polygon-r').click();
  await expect(page.getByTestId('pt-r.p1-x')).toHaveValue('10');
  await expect(page.getByTestId('dim-r.width')).toHaveCount(0);

  // 2. 오른쪽 변(e1)을 반원(볼록 1)으로 → 형상이 x = 20 까지
  await page.getByTestId('bulge-r.e1').fill('1');
  await page.getByTestId('bulge-r.e1').press('Enter');
  await expect.poll(async () => (await sources(page)).e?.max[0] ?? 0, { timeout: 20_000 }).toBeCloseTo(20, 2);

  // 3. 호에 붙지 않은 꼭짓점 p3 만 필렛 R4 → 왼쪽 위 모서리만 둥글게 (정점 수 증가)
  const before = (await sources(page)).e!.vertices;
  await page.getByTestId('corner-v3').check();
  await page.getByTestId('corner-size').fill('4');
  await page.getByTestId('corner-size').press('Enter');
  await expect.poll(async () => (await sources(page)).e?.vertices ?? 0, { timeout: 20_000 }).toBeGreaterThan(before);
  await expect(page.getByText('처리된 꼭짓점: p3')).toBeVisible();
  // 호 변에 붙은 꼭짓점(p1)은 거부 (모델은 그대로)
  const rev = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).revision;
  await page.getByTestId('corner-v3').uncheck();
  await page.getByTestId('corner-v1').check();
  await page.getByTestId('corner-size').fill('2');
  await page.getByTestId('corner-size').press('Enter');
  await expect(page.getByRole('alert').filter({ hasText: '호 변' }).first()).toBeVisible();
  expect((await page.evaluate(() => window.__AI3D_DEV__!.scene())).revision).toBe(rev);

  // 4. 대칭 구속: 구성선(세로 축 u = 0) 에 대해 p0·p1 대칭 → p1 을 옮기면 p0 이 따라온다
  await dispatch(page, { type: 'add_line', sketch: 's', id: 'ax', points: [[0, -30], [0, 30]] });
  await dispatch(page, { type: 'add_constraint', sketch: 's', constraint: 'fix', refs: ['ax.p0'] });
  await dispatch(page, { type: 'add_constraint', sketch: 's', constraint: 'vertical', refs: ['ax.e0'] });
  await page.getByTestId('pair-type').selectOption('symmetric');
  await page.getByTestId('pair-a').selectOption('r.p0');
  await page.getByTestId('pair-b').selectOption('r.p1');
  await page.getByTestId('pair-c').selectOption('ax.e0');
  await page.getByTestId('pair-add').click();
  await expect(page.getByTestId('constraint-k3')).toContainText('대칭');
  await page.getByTestId('pt-r.p1-x').fill('14');
  await page.getByTestId('pt-r.p1-x').press('Enter');
  await expect(page.getByTestId('pt-r.p0-x')).toHaveValue('-14');
  await expect(page.getByTestId('pt-r.p0-y')).toHaveValue(await page.getByTestId('pt-r.p1-y').inputValue());
});
