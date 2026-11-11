/** 판금 (형식 v45, 두 엔진): 툴바 → 쟁반 → 플랜지 높이 바꾸기 → 전개도 DXF → 저장 v45 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());

for (const engine of ['server', 'browser'] as const) {
  test(`판금 쟁반·전개도 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.addInitScript(() => {
      for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
    });
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.getByRole('tab', { name: '피처' }).click();
    await page.getByTestId('cmd-sheet-metal').click();
    const id = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects.at(-1)!.id;
    // 네 변 20mm 플랜지 쟁반: 높이 20, 가로 80
    await expect.poll(async () => (await sources(page))[id]?.source, { timeout: 30_000 }).toBe(engine);
    const size = async () => {
      const m = (await sources(page))[id]!;
      const [a, b] = [m.min as number[], m.max as number[]];
      return [b[0]! - a[0]!, b[1]! - a[1]!, b[2]! - a[2]!].map((v) => Math.round(v * 100) / 100);
    };
    expect(await size()).toEqual([80, 60, 20]);
    // 속성: +X 플랜지 35 로 → 높이 35
    await page.getByTestId('param-flangePX').fill('35');
    await page.getByTestId('param-flangePX').press('Enter');
    await expect.poll(size, { timeout: 30_000 }).toEqual([80, 60, 35]);
    // 너무 낮은 플랜지는 거부 (굽힘 바깥 반지름 3 이하)
    await page.getByTestId('param-flangeNY').fill('2');
    await page.getByTestId('param-flangeNY').press('Enter');
    await expect(page.getByRole('alert').first()).toContainText('플랜지 높이');
    // 전개도
    await expect(page.getByTestId('sheet-flat-size')).toContainText('전개 크기');
    const [dxf] = await Promise.all([page.waitForEvent('download'), page.getByTestId('sheet-dxf').click()]);
    const text = readFileSync((await dxf.path())!, 'utf8');
    expect(text.match(/\nOUTLINE\n/g)!.length).toBe(12);
    expect(text.match(/\nBEND\n/g)!.length).toBe(8);
    // 저장
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
    const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
    expect(saved.formatVersion).toBe(46);
    expect(saved.model.objects.at(-1)).toMatchObject({ kind: 'sheet', params: { flangePX: 35, flangeNY: 20 } });
  });
}
