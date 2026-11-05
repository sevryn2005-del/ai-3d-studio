/**
 * 형식 v15 화면 흐름 (두 엔진): 사각형 + 원 두 개 → 영역(합치기·빼기)으로 구멍 뚫린 판 → 원 지름 바꾸면 따라감 → 호 그리기.
 * 형상 부피는 공유 픽스처(region-*)가 세 엔진에서 검사한다.
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const dispatch = (page: Page, cmd: unknown) => page.evaluate((c) => window.__AI3D_DEV__!.dispatch(c), cmd);

for (const engine of ['server', 'browser'] as const) {
  test(`영역 단면·호 그리기 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    test.setTimeout(90_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.getByRole('button', { name: '삭제', exact: true }).click();
    for (const c of [
      { type: 'create_sketch', id: 's', plane: { type: 'XY', offset: 0 } },
      { type: 'add_rectangle', sketch: 's', id: 'r', center: [0, 0], width: 40, height: 20 },
      { type: 'add_circle', sketch: 's', id: 'c1', center: [-10, 0], diameter: 6 },
      { type: 'add_circle', sketch: 's', id: 'c2', center: [30, 0], diameter: 20 },
    ])
      await dispatch(page, c);

    // 1. 영역 만들기: 첫 요소(사각형)에서 나머지를 뺀다 → c2 는 합치기로 바꿈
    await page.locator('[data-sketch-id="s"]').click();
    await page.getByTestId('add-region').click();
    await expect(page.getByTestId('region-item-c1')).toBeVisible();
    await expect(page.getByTestId('region-op-r')).toBeDisabled();
    await page.getByTestId('region-op-c2').selectOption('add');
    // 구성 요소는 영역이 쓰는 동안 지울 수 없다
    await expect(page.getByTestId('delete-entity-c1')).toBeDisabled();

    // 2. 영역 돌출 → 사각형 + 오른쪽 원(합치기) 범위
    await page.getByTestId('extrude-region1').click();
    await expect.poll(async () => (await sources(page)).extrude_1?.source, { timeout: 30_000 }).toBe(engine);
    const e1 = (await sources(page)).extrude_1!;
    expect(e1.min[0]).toBeCloseTo(-20, 2);
    expect(e1.max[0]).toBeCloseTo(40, 1); // 화면 메시(원 근사)

    // 3. 오른쪽 원 지름 20 → 30: 영역도 따라 바뀐다
    await page.locator('[data-sketch-id="s"]').click();
    await page.getByTestId('dim-c2.diameter').fill('30');
    await page.getByTestId('dim-c2.diameter').press('Enter');
    await expect.poll(async () => (await sources(page)).extrude_1?.max[0] ?? 0, { timeout: 30_000 }).toBeCloseTo(45, 1);

    // 4. 영역에서 c2 를 빼면(✕) 사각형 − 구멍만
    await page.getByTestId('region-remove-c2').click();
    await expect.poll(async () => (await sources(page)).extrude_1?.max[0] ?? 0, { timeout: 30_000 }).toBeCloseTo(20, 2);

    // 5. 호 그리기: 시작 → 끝 → 지날 점 (반원)
    await page.getByRole('tab', { name: '스케치' }).click();
    await page.getByTestId('cmd-arc').click();
    const click = async (x: number, y: number) => {
      const p = await page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
      await page.mouse.click(p.x, p.y);
    };
    await click(0, 30);
    await click(20, 30);
    await click(10, 40);
    await page.keyboard.press('Escape');
    await page.locator('[data-sketch-id="s"]').click();
    await expect(page.getByTestId('bulge-arc1.e0')).toHaveValue('-1');
  });
}
