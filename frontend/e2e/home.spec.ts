/**
 * 시작 화면 (형식 v19): 처음 켜면 작업 모드를 고른다. 설계 = 빈 부품(평면·원점만) + 솔리드웍스식 안내,
 * 스케치 → 사각형 → ✓ → 돌출. 저장하면 모드가 남고, "새 프로젝트" 는 다시 시작 화면으로. 자동 저장본은 "이어서 작업".
 */
import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('시작 화면 → 설계 모드: 빈 부품에서 스케치 → 돌출, 모드 저장, 이어서 작업', async ({ page }) => {
  test.setTimeout(90_000);
  // 저장은 다운로드 방식으로 (파일 선택 창 API 를 가린다 — project.spec 과 같음)
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await expect(page.getByTestId('home')).toBeVisible();
  await expect(page.getByTestId('home-resume')).toHaveCount(0); // 처음이라 자동 저장본 없음

  // 1. 설계 → 빈 부품 + 안내, 기본 도형 버튼 없음
  await page.getByTestId('home-design').click();
  await expect(page.getByTestId('mode-badge')).toHaveText('설계');
  await expect(page.getByTestId('design-start-guide')).toBeVisible();
  await expect(page.getByRole('button', { name: '+ 박스' })).toHaveCount(0);
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  expect((await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects).toEqual([]);

  // 2. 안내의 "스케치 시작" → 평면 고르기 → 윗면 → 사각형 그리기
  await page.getByTestId('guide-start-sketch').click();
  // 평면 고르는 중에는 트리에서 눌러도 된다 (솔리드웍스처럼)
  await page.locator('[data-plane="XY"]').click();
  await expect(page.getByTestId('design-start-guide')).toHaveCount(0);
  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByRole('button', { name: /^사각형/ }).click();
  const a = await at(-20, -10);
  const b = await at(20, 10);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  expect((await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches).toHaveLength(1);

  // 3. 피처 → 돌출 보스 → ✓
  await page.getByRole('tab', { name: '피처' }).click();
  await page.getByRole('button', { name: /돌출 보스/ }).click();
  await page.getByRole('button', { name: /확인|✓/ }).first().click();
  await expect.poll(async () => (await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects.length, { timeout: 20_000 }).toBe(1);

  // 4. 저장 → 파일에 모드가 남는다
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(26);
  expect(saved.model.workspace).toBe('design');

  // 5. 새로 고침 → 시작 화면, 자동 저장본을 "이어서 작업" 으로
  await page.reload();
  await expect(page.getByTestId('home')).toBeVisible();
  await page.getByTestId('home-resume').click();
  await expect(page.getByTestId('mode-badge')).toHaveText('설계');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  expect((await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects).toHaveLength(1);

  // 6. 새 프로젝트 → (저장 안 한 변경이 없으면 바로) 시작 화면
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await expect(page.getByTestId('home')).toBeVisible();
});
