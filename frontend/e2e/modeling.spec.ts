/**
 * 3D 모델링 모드 (형식 v20, 블렌더 흐름): 시작 화면 → 큐브 추가 → G Z 10 → Tab 편집 모드 → 면 클릭 → E 5 → I 2 →
 * 실행 취소 → 저장(polymesh) → STL 내보내기(닫힌 메시는 엔진이 솔리드로).
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

const stats = (page: Page) => page.getByTestId('mesh-stats');

test('모델링 모드: 메시 추가 → 이동 → 편집 모드 돌출·인셋 → 저장·STL', async ({ page }, info) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.getByTestId('home-modeling').click();
  await expect(page.getByTestId('mode-badge')).toHaveText('3D 모델링');
  await expect(page.getByTestId('modeling-start-guide')).toBeVisible();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);

  // 1. 큐브 추가 (바닥 위: 가운데 z = 10)
  await page.getByTestId('guide-add-cube').click();
  await expect(page.getByTestId('outliner')).toContainText('큐브 1');
  await expect(stats(page)).toContainText('점8');
  await expect(stats(page)).toContainText('면6');
  await expect(stats(page)).toContainText('닫힘');
  await expect(page.getByTestId('loc-z')).toHaveValue('10');

  // 2. G Z 10 Enter (뷰포트 위에서)
  const vp = page.locator('.modeling-viewport canvas');
  const box = (await vp.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const k of ['g', 'z', '1', '0']) await page.keyboard.press(k);
  await expect(page.getByTestId('modeling-hint')).toContainText('이동 Z축 10');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('loc-z')).toHaveValue('20');

  // 3. Tab 편집 모드 → 면 선택 모드 → 위에서 보고 가운데 클릭 = 윗면
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('mode-edit')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('3');
  await page.keyboard.press('Numpad7');
  await expect.poll(() => page.evaluate(() => window.__AI3D_DEV__!.cameraDir())).toEqual([0, 0, -1]);
  const top = await page.evaluate(() => window.__AI3D_DEV__!.project(0, 0, 30));
  await page.mouse.click(top.x, top.y);
  await expect(page.getByTestId('edit-selection')).toContainText('면 1/6');

  // 4. E 5 Enter: 위로 5mm 돌출 → 점 12, 면 10, 새 윗면이 선택된 채
  for (const k of ['e', '5']) await page.keyboard.press(k);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('edit-selection')).toContainText('면 1/10');
  await expect(stats(page)).toContainText('점12');
  // 5. I 2 Enter: 인셋 → 면 14
  for (const k of ['i', '2']) await page.keyboard.press(k);
  await page.keyboard.press('Enter');
  await expect(stats(page)).toContainText('면14');
  // 6. 실행 취소 1번 = 인셋만
  await page.keyboard.press('Control+z');
  await expect(stats(page)).toContainText('면10');

  // 7. Tab 으로 나가서 저장 → 파일에 모델링 모드 + 메시
  await page.keyboard.press('Tab');
  await expect(page.getByTestId('mode-object')).toHaveAttribute('aria-pressed', 'true');
  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(21);
  expect(saved.model.workspace).toBe('modeling');
  const obj = saved.model.objects[0];
  expect(obj.kind).toBe('polymesh');
  expect(obj.transform.position).toEqual([0, 0, 20]);
  expect(obj.polymesh.faces).toHaveLength(10);
  expect(Math.max(...obj.polymesh.verts.map((v: number[]) => v[2]))).toBeCloseTo(15); // 로컬 윗면 10 + 돌출 5

  // 8. STL 내보내기: 닫힌 메시는 엔진이 솔리드로 (20×20×25)
  await page.getByRole('button', { name: '내보내기 ▾' }).click();
  const [stl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^STL/ }).click()]);
  expect(stl.suggestedFilename()).toMatch(/\.stl$/);
  const buf = readFileSync((await stl.path())!);
  expect(buf.length).toBeGreaterThan(84);
  await page.screenshot({ path: info.outputPath('modeling.png') });
  await expect(page.getByRole('alert')).toHaveCount(0);
});
