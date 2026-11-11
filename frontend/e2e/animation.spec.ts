/** 애니메이션 (형식 v43·v44 보간·영상): 타임라인 → 프레임 0 키 → 24 에서 옮겨 키 → 12 프레임은 가운데 → 재생 → 닫으면 설계 위치, 저장 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test('애니메이션: 키 넣기·보간·재생·저장', async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  const box = async () => (await page.evaluate(() => window.__AI3D_DEV__!.meshSources())).box_1!;
  await expect.poll(async () => (await box())?.source, { timeout: 20_000 }).toBe('server');
  await page.getByRole('tab', { name: '보기' }).click();
  await page.getByTestId('cmd-timeline').click();
  await expect(page.getByTestId('timeline')).toBeVisible();
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByTestId('tl-key').click(); // 프레임 0 = 지금 자리
  await page.getByTestId('tl-frame').fill('24');
  await expect(page.getByTestId('tl-frame-num')).toHaveText('24 / 120');
  // 24 프레임: X 로 40 옮긴 자리 (기즈모 대신 같은 명령)
  await page.evaluate(() => window.__AI3D_DEV__!.dispatch({ type: 'insert_keyframe', target: 'box_1', frame: 24, position: [40, 0, 0], rotation: [0, 0, 0] }));
  await expect.poll(async () => (await box()).min[0]).toBeCloseTo(30, 3);
  await page.getByTestId('tl-frame').fill('12');
  await expect.poll(async () => (await box()).min[0]).toBeCloseTo(10, 3);
  // 보간 방식 (형식 v44): 프레임 0 키를 계단으로 → 12 프레임은 아직 처음 자리, 부드럽게 → 가운데(대칭이라 같음), 6 프레임은 1/4 보다 덜
  await page.getByTestId('tl-frame').fill('0');
  await page.getByTestId('tl-interp').selectOption('constant');
  await page.getByTestId('tl-frame').fill('12');
  await expect.poll(async () => (await box()).min[0]).toBeCloseTo(-10, 3);
  await page.getByTestId('tl-frame').fill('0');
  await page.getByTestId('tl-interp').selectOption('ease');
  await page.getByTestId('tl-frame').fill('6');
  await expect.poll(async () => (await box()).min[0]).toBeCloseTo(-10 + 40 * 0.15625, 3);
  // 영상 저장: 끝 프레임을 짧게 해 WebM 한 편
  await page.getByTestId('tl-end').fill('24');
  const [video] = await Promise.all([page.waitForEvent('download', { timeout: 20_000 }), page.getByTestId('tl-video').click()]);
  expect(video.suggestedFilename()).toMatch(/\.webm$/);
  const bytes = readFileSync((await video.path())!);
  expect(bytes.length).toBeGreaterThan(1000);
  expect(bytes.subarray(0, 4).toString('hex')).toBe('1a45dfa3'); // EBML (WebM) 머리
  await page.getByTestId('tl-frame').fill('12');
  // 재생하면 프레임이 넘어간다
  await page.getByTestId('tl-play').click();
  await expect.poll(async () => Number((await page.getByTestId('tl-frame-num').textContent())!.split(' ')[0]), { timeout: 10_000 }).not.toBe(12);
  await page.getByTestId('tl-play').click();
  // 설계 위치는 그대로, 타임라인을 닫으면 설계 위치로 보인다
  expect((await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects.find((o) => o.id === 'box_1')!.position).toEqual([0, 0, 0]);
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(44);
  expect(saved.model.animation.tracks[0].keys.map((k: { frame: number }) => k.frame)).toEqual([0, 24]);
  await page.getByTestId('cmd-timeline').click();
  await expect.poll(async () => (await box()).min[0]).toBeCloseTo(-10, 3);
});
