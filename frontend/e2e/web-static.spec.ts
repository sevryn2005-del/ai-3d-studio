/**
 * 정적 웹 배포본 검증 (백엔드·프록시 없음, VITE_CAD_ENGINE=browser 빌드).
 *   VITE_CAD_ENGINE=browser npx vite build --outDir dist-web
 *   (dist-web 을 아무 정적 서버로 제공)
 *   E2E_WEB_STATIC=http://127.0.0.1:4180 npx playwright test e2e/web-static.spec.ts
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

const base = process.env.E2E_WEB_STATIC;
test.skip(!base, 'E2E_WEB_STATIC 이 지정된 경우에만 실행');

test('정적 웹: 서버 요청 0건, 외부 요청 0건으로 모델링·저장·STL/3MF/GLB 내보내기', async ({ page }) => {
  const apiCalls: string[] = [];
  const external: string[] = [];
  await page.context().route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (url.pathname.startsWith('/api/')) apiCalls.push(url.href);
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto(base!);
  await expect(page.getByTestId('cad-engine')).toHaveText('CAD: 브라우저 엔진');
  await expect(page.getByTestId('server-status')).toHaveCount(0); // 서버 개념 없음
  await expect(page.getByTestId('server-evaluation')).toHaveText('브라우저 계산 ✓', { timeout: 20_000 });

  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');
  await expect(page.locator('.object-list')).toContainText('20×20×50');
  await expect(page.getByTestId('server-evaluation')).toHaveText('브라우저 계산 ✓');

  const menu = page.getByRole('button', { name: '내보내기 ▾' });
  for (const fmt of ['stl', '3mf', 'glb']) {
    await menu.click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: new RegExp(`^${fmt.toUpperCase()}`) }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`제목 없음.${fmt}`);
    const bytes = readFileSync((await download.path())!);
    if (fmt === 'stl') {
      // 높이 50mm 가 파일에 정확히 반영
      const count = bytes.readUInt32LE(80);
      let maxZ = -Infinity;
      for (let i = 0; i < count; i++) for (let v = 0; v < 3; v++) maxZ = Math.max(maxZ, bytes.readFloatLE(84 + i * 50 + 12 + v * 12 + 8));
      expect(maxZ).toBeCloseTo(50, 5);
    }
  }

  expect(apiCalls).toEqual([]);
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});

test('정적 웹: 사각형 스케치 → 돌출 → 폭 80 → 관통 구멍 → STL (브라우저 엔진)', async ({ page }) => {
  const apiCalls: string[] = [];
  await page.context().route('**/*', (route) => {
    if (new URL(route.request().url()).pathname.startsWith('/api/')) apiCalls.push(route.request().url());
    return route.continue();
  });
  await page.goto(base!);
  await page.getByRole('button', { name: '삭제' }).click();
  await page.getByRole('button', { name: '+ 사각형 스케치' }).click();
  await page.getByTestId('extrude-r1').click();
  const w = page.getByTestId('dim-r1.width');
  await w.fill('80');
  await w.press('Enter');
  await expect(page.locator('[data-object-id="extrude_1"]')).toContainText('80×40×4');
  const x = page.getByTestId('hole-x');
  await x.fill('18');
  await x.press('Enter');
  await page.getByTestId('hole-apply').click();
  await expect(page.locator('[data-object-id="cut_1"]')).toBeVisible();
  await expect(page.getByTestId('server-evaluation')).toHaveText('브라우저 계산 ✓', { timeout: 20_000 });
  await expect(page.getByTestId('print-check')).toHaveText('출력 검사 ✓', { timeout: 20_000 });

  await page.getByRole('button', { name: '내보내기 ▾' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^STL/ }).click()]);
  const b = readFileSync((await download.path())!);
  const count = b.readUInt32LE(80);
  const min = [Infinity, Infinity, Infinity];
  const max = [-Infinity, -Infinity, -Infinity];
  let vol = 0;
  for (let i = 0; i < count; i++) {
    const p = [0, 1, 2].map((v) => [0, 1, 2].map((k) => b.readFloatLE(84 + i * 50 + 12 + v * 12 + k * 4)));
    for (const q of p) for (let k = 0; k < 3; k++) [min[k], max[k]] = [Math.min(min[k]!, q[k]!), Math.max(max[k]!, q[k]!)];
    const [a, c, d] = p as [number[], number[], number[]];
    vol += a[0]! * (c[1]! * d[2]! - c[2]! * d[1]!) - a[1]! * (c[0]! * d[2]! - c[2]! * d[0]!) + a[2]! * (c[0]! * d[1]! - c[1]! * d[0]!);
  }
  min.forEach((v, k) => expect(v).toBeCloseTo([-40, -20, 0][k]!, 4));
  max.forEach((v, k) => expect(v).toBeCloseTo([40, 20, 4][k]!, 4));
  expect(Math.abs(vol / 6 - (80 * 40 * 4 - Math.PI * 9 * 4)) / (80 * 40 * 4)).toBeLessThan(2e-3);
  expect(apiCalls).toEqual([]);
});

test('정적 웹: 정밀 엔진(OCCT WASM 압축본)으로 필렛 → STEP 내보내기, 외부 요청 0건', async ({ page }) => {
  test.setTimeout(90_000);
  const external: string[] = [];
  await page.context().route('**/*', (route) => {
    const url = new URL(route.request().url());
    if (!['127.0.0.1', 'localhost'].includes(url.hostname) && !['data:', 'blob:'].includes(url.protocol)) {
      external.push(url.href);
      return route.abort();
    }
    return route.continue();
  });
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));
  await page.goto(base!);
  await expect(page.getByTestId('server-evaluation')).toHaveText('브라우저 계산 ✓', { timeout: 20_000 });
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByTestId('cmd-fillet').click();
  await expect(page.locator('[data-object-id="fillet_1"]')).toBeVisible();
  await expect(page.getByTestId('server-evaluation')).toHaveText('브라우저 계산 ✓', { timeout: 60_000 });
  await page.getByRole('button', { name: '내보내기 ▾' }).click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^STEP/ }).click()]);
  expect(readFileSync((await download.path())!).subarray(0, 12).toString()).toBe('ISO-10303-21');
  expect(external).toEqual([]);
  expect(errors).toEqual([]);
});
