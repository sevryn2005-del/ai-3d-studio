/**
 * 솔리드웍스식 면 → 스케치 (두 엔진): 구멍 뚫린 판의 윗면
 * 1) 스케치 없이 "돌출" → 면 클릭 → 그 면 윤곽(바깥 − 구멍) 스케치 + 돌출 확인 → 판 위에 구멍까지 그대로 솟음
 * 2) 요소 변환: 새 스케치를 고른 채 같은 면 클릭 → 윤곽 3요소(다각형·원·영역)
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const scene = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());
async function clickAt(page: Page, x: number, y: number, z: number) {
  const p = await page.evaluate(([x, y, z]) => window.__AI3D_DEV__!.project(x!, y!, z!), [x, y, z]);
  await page.mouse.click(p.x, p.y);
}
const ready = (page: Page) => expect(page.getByTestId('pick-bar')).toHaveAttribute('data-ready', 'true', { timeout: 30_000 });

for (const engine of ['server', 'browser'] as const) {
  test(`면 윤곽으로 바로 돌출·요소 변환 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    test.setTimeout(120_000);
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await page.evaluate(() => {
      const d = window.__AI3D_DEV__!;
      d.dispatch({ type: 'delete_object', target: 'box_1' });
      d.dispatch({ type: 'create_box', id: 'b', width: 40, depth: 30, height: 5 });
      d.dispatch({ type: 'create_cylinder', id: 'c', radius: 5, height: 9, position: [-8, 0, -2] });
      d.dispatch({ type: 'cut', id: 'plate', base: 'b', tools: ['c'] });
    });
    await expect.poll(async () => (await sources(page)).plate?.source, { timeout: 30_000 }).toBe(engine);

    // 1. 스케치 없이 돌출 → 면 고르기
    await page.getByRole('tab', { name: '피처' }).click();
    await page.getByRole('button', { name: '돌출 보스/베이스' }).click();
    await ready(page);
    await clickAt(page, 12, 8, 5);
    await expect(page.getByTestId('confirm-ok')).toBeVisible({ timeout: 10_000 });
    const sk = (await scene(page)).sketches.at(-1)!;
    expect(sk.entities.map((e) => e.type).sort()).toEqual(['circle', 'polygon', 'region']);
    await page.getByTestId('confirm-ok').click();
    const extrude = async () => {
      const s = await sources(page);
      return Object.entries(s).find(([id]) => id.startsWith('extrude'))?.[1];
    };
    await expect.poll(async () => (await extrude())?.source, { timeout: 30_000 }).toBe(engine);
    const e = (await extrude())!;
    expect(e.min[2]).toBeCloseTo(5, 3); // 판 윗면에서 시작
    const [lo, hi] = [e.min as number[], e.max as number[]];
    expect(hi[0]! - lo[0]!).toBeCloseTo(40, 3);
    expect(hi[1]! - lo[1]!).toBeCloseTo(30, 3);

    // 2. 요소 변환: 새 스케치(높이 30) 고르고 돌출 윗면(같은 윤곽) 클릭
    await page.evaluate(() => window.__AI3D_DEV__!.dispatch({ type: 'create_sketch', id: 's2', plane: { type: 'XY', offset: 30 } }));
    await page.locator('[data-sketch-id="s2"]').click();
    await page.getByRole('tab', { name: '스케치' }).click();
    await page.getByTestId('cmd-convert').click();
    await ready(page);
    await clickAt(page, -18, -12, hi[2]!);
    await expect
      .poll(async () => (await scene(page)).sketches.find((s) => s.id === 's2')!.entities.map((x) => x.type).sort(), { timeout: 10_000 })
      .toEqual(['circle', 'polygon', 'region']);
    const circle = (await scene(page)).sketches.find((s) => s.id === 's2')!.entities.find((x) => x.type === 'circle')! as { center: number[] };
    expect(circle.center[0]).toBeCloseTo(-8, 2);
    // 실행 취소 1번 = 변환 전체
    await page.keyboard.press('Control+z');
    await expect.poll(async () => (await scene(page)).sketches.find((s) => s.id === 's2')!.entities.length).toBe(0);
  });
}
