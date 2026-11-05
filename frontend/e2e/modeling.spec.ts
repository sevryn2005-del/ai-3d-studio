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
  expect(saved.formatVersion).toBe(22);
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

test('모디파이어: Ctrl+2 세분 표면 → 미러 추가 → 부드러운 음영 → 맨 위 적용 → 저장', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.getByTestId('home-modeling').click();
  await page.getByTestId('guide-add-cube').click();
  await expect(page.getByTestId('mesh-stats')).toContainText('면6');
  const vp = page.locator('.modeling-viewport canvas');
  const box = (await vp.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  // Ctrl+2: 세분 표면 2단계 (원본 메시는 그대로, 결과만 바뀜)
  await page.keyboard.press('Control+2');
  await expect(page.getByTestId('modifier-0')).toContainText('세분 표면');
  await expect(page.getByTestId('mod-0-levels')).toHaveValue('2');
  await expect(page.getByTestId('mesh-stats')).toContainText('면6');
  // 미러 추가 (아래에 쌓인다), 부드러운 음영
  await page.getByTestId('modifier-add').selectOption('mirror');
  await expect(page.getByTestId('modifier-1')).toContainText('미러');
  await page.getByTestId('shade-smooth').click();
  await expect(page.getByTestId('shade-smooth')).toHaveAttribute('aria-pressed', 'true');
  // 맨 위(세분 표면) 적용 → 원본이 96면, 미러만 남음
  await page.getByTestId('modifier-apply').click();
  await expect(page.getByTestId('mesh-stats')).toContainText('면96');
  await expect(page.getByTestId('modifier-0')).toContainText('미러');
  await expect(page.getByTestId('modifier-1')).toHaveCount(0);
  // 실행 취소 1번 = 적용만 되돌림
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('mesh-stats')).toContainText('면6');
  await expect(page.getByTestId('modifier-1')).toContainText('미러');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(22);
  expect(saved.model.objects[0]).toMatchObject({ smooth: true, modifiers: [{ type: 'subsurf', levels: 2 }, { type: 'mirror', axis: 'x', merge: true }] });
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('스컬프트: 구에 그리기 브러시로 한 획 → 부풀어 오름, 실행 취소 1번', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.getByTestId('home-modeling').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-add-uv_sphere').click();
  await page.getByTestId('mode-sculpt').click();
  await expect(page.getByTestId('modeling-hint')).toContainText('스컬프트 모드');
  await page.getByTestId('sculpt-densify').click();
  await expect(page.getByTestId('notice')).toContainText('촘촘하게');
  // 위에서 보고 구 가운데를 가로지르는 한 획 (그리기 브러시, 세기 100%)
  await page.getByTestId('sculpt-strength').fill('1');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur()); // 단축키가 슬라이더가 아니라 화면으로
  await page.keyboard.press('Numpad7');
  await expect.poll(() => page.evaluate(() => window.__AI3D_DEV__!.cameraDir())).toEqual([0, 0, -1]);
  const a = await page.evaluate(() => window.__AI3D_DEV__!.project(-4, 0, 20));
  const b = await page.evaluate(() => window.__AI3D_DEV__!.project(4, 0, 20));
  await page.mouse.move(a.x, a.y);
  await expect(page.locator('[data-testid="modeling-hint"]')).toBeVisible();
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 12 });
  await page.mouse.up();

  const save = async () => {
    const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
    const obj = JSON.parse(readFileSync((await dl.path())!, 'utf8')).model.objects[0];
    return Math.max(...obj.polymesh.verts.map((v: number[]) => Math.hypot(v[0]!, v[1]!, v[2]!)));
  };
  const after = await save();
  expect(after).toBeGreaterThan(10.05); // 반지름 10 구가 획 자리에서 부풀었다
  await page.keyboard.press('Control+z'); // 획 1번 = 실행 취소 1번
  expect(await save()).toBeLessThanOrEqual(10.000001);
});

test('편집 모드: 선 클릭 → Ctrl+B 베벨 2mm → 면 7, Ctrl+L 연결 선택, 도넛 Alt+클릭 루프', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-modeling').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-add-cube').click();
  const box = (await page.locator('.modeling-viewport canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Tab');
  await page.keyboard.press('2'); // 선 선택
  await page.keyboard.press('Numpad7');
  await expect.poll(() => page.evaluate(() => window.__AI3D_DEV__!.cameraDir())).toEqual([0, 0, -1]);
  // 윗면 오른쪽 선 (x = 10) 가운데를 클릭
  const e = await page.evaluate(() => window.__AI3D_DEV__!.project(10, 0, 20));
  await page.mouse.click(e.x, e.y);
  await expect(page.getByTestId('edit-selection')).toContainText('선 1');
  await page.keyboard.press('Control+b');
  await page.keyboard.type('2');
  await expect(page.getByTestId('modeling-hint')).toContainText('베벨');
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('mesh-stats')).toContainText('면7');
  await expect(page.getByTestId('mesh-stats')).toContainText('닫힘');
  await expect(page.getByTestId('edit-selection')).toContainText('면 1/7'); // 새 베벨 면이 선택된 채
  // Ctrl+L: 이어진 점 전부
  await page.keyboard.press('Control+l');
  await expect(page.getByTestId('edit-selection')).toContainText('점 10/10');
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('mesh-stats')).toContainText('면6');

  // 도넛: 점 모드에서 Alt+클릭 = 한 바퀴 루프
  await page.keyboard.press('Tab');
  await page.getByTestId('add-menu-button').click();
  await page.getByRole('menuitem', { name: '도넛' }).click();
  await page.keyboard.press('Tab');
  await page.keyboard.press('1');
  await page.keyboard.press('Numpad7');
  await page.waitForTimeout(400);
  const torus = await page.evaluate(() => window.__AI3D_DEV__!.scene());
  const t = torus.objects.find((o) => o.id !== 'mesh_1')!;
  const [tx, ty, tz] = t.position as [number, number, number];
  // 바깥 둘레(반지름 10 + 3) 오른쪽 점과 위쪽 이웃 점 사이 선 근처
  const q = await page.evaluate(([x, y, z]) => window.__AI3D_DEV__!.project(x!, y!, z!), [tx + 13 * Math.cos(Math.PI / 48), ty + 13 * Math.sin(Math.PI / 48), tz]);
  await page.keyboard.down('Alt');
  await page.mouse.click(q.x, q.y);
  await page.keyboard.up('Alt');
  await expect(page.getByTestId('edit-selection')).toContainText('점 48/');
});

test('비례 편집: 격자 가운데 점 하나 G Z 5 → 주변 점이 부드럽게 따라온다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.getByTestId('home-modeling').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('add-menu-button').click();
  await page.getByRole('menuitem', { name: '격자' }).click(); // 20×20, 10칸, 바닥 z = 0
  const box = (await page.locator('.modeling-viewport canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Tab');
  await page.keyboard.press('Numpad7');
  await expect.poll(() => page.evaluate(() => window.__AI3D_DEV__!.cameraDir())).toEqual([0, 0, -1]);
  const c = await page.evaluate(() => window.__AI3D_DEV__!.project(0, 0, 0));
  await page.mouse.click(c.x, c.y);
  await expect(page.getByTestId('edit-selection')).toContainText('점 1/121');
  await page.keyboard.press('o');
  await expect(page.getByTestId('proportional')).toHaveAttribute('aria-pressed', 'true');
  await page.getByTestId('proportional-radius').fill('6');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  for (const k of ['g', 'z', '5']) await page.keyboard.press(k);
  await expect(page.getByTestId('modeling-hint')).toContainText('비례 6mm');
  await page.keyboard.press('Enter');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const verts: number[][] = JSON.parse(readFileSync((await dl.path())!, 'utf8')).model.objects[0].polymesh.verts;
  const z = (x: number, y: number) => verts.find((v) => Math.abs(v[0]! - x) < 1e-6 && Math.abs(v[1]! - y) < 1e-6)![2]!;
  expect(z(0, 0)).toBeCloseTo(5);
  expect(z(2, 0)).toBeGreaterThan(0);
  expect(z(2, 0)).toBeLessThan(5);
  expect(z(4, 0)).toBeLessThan(z(2, 0));
  expect(z(10, 10)).toBe(0); // 반지름 밖은 그대로
});

test('불리언 빼기(큐브 − 구) → 메시로 변환 → 편집 가능, 실행 취소', async ({ page }) => {
  test.setTimeout(120_000);
  await page.goto('/');
  await page.getByTestId('home-modeling').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-add-cube').click();
  await page.getByTestId('add-menu-button').click();
  await page.getByRole('menuitem', { name: 'UV 구' }).click();
  // 구를 큐브 위 모서리 쪽으로 (겹치게)
  for (const [id, v] of [['loc-x', '8'], ['loc-y', '8'], ['loc-z', '18']] as const) {
    await page.getByTestId(id).fill(v);
    await page.getByTestId(id).press('Enter');
  }
  // 큐브를 고르고 빼기
  await page.getByTestId('outliner').getByRole('button', { name: '큐브 1' }).click();
  await expect(page.getByTestId('boolean-tool')).toContainText('UV 구'); // 다른 객체는 구 하나
  await page.getByTestId('bool-cut').click();
  await expect(page.getByTestId('outliner').locator('li')).toHaveCount(1);
  // 엔진 계산이 끝나면 메시로 변환
  await expect(page.getByTestId('convert-to-mesh')).toBeEnabled({ timeout: 30_000 });
  await page.getByTestId('convert-to-mesh').click();
  await expect(page.getByTestId('mesh-stats')).toContainText('닫힘');
  const faces = Number((await page.getByTestId('mesh-stats').locator('dd').nth(2).textContent())!.replace(/,/g, ''));
  expect(faces).toBeGreaterThan(30); // 큐브 6면 + 파인 구면
  await expect(page.getByTestId('modifier-stack')).toBeVisible(); // 이제 메시 — 모디파이어·편집 가능
  await page.keyboard.press('Control+z');
  await expect(page.getByTestId('convert-to-mesh')).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('스컬프트 마스크: Ctrl+I 로 전부 가리면 획이 아무것도 바꾸지 않고, Alt+M 으로 지우면 다시 된다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.getByTestId('home-modeling').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-add-uv_sphere').click();
  await page.getByTestId('mode-sculpt').click();
  await page.getByTestId('sculpt-strength').fill('1');
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  const box = (await page.locator('.modeling-viewport canvas').boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.keyboard.press('Numpad7');
  await expect.poll(() => page.evaluate(() => window.__AI3D_DEV__!.cameraDir())).toEqual([0, 0, -1]);
  const stroke = async () => {
    const a = await page.evaluate(() => window.__AI3D_DEV__!.project(-4, 0, 20));
    const b = await page.evaluate(() => window.__AI3D_DEV__!.project(4, 0, 20));
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 10 });
    await page.mouse.up();
  };
  const undoEnabled = () => page.getByRole('button', { name: '실행 취소' }).isEnabled();
  await page.keyboard.press('Control+i'); // 전부 가림
  const before = await page.getByRole('button', { name: '실행 취소' }).isEnabled();
  await stroke();
  await page.waitForTimeout(300);
  const [dl1] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const r1 = Math.max(...JSON.parse(readFileSync((await dl1.path())!, 'utf8')).model.objects[0].polymesh.verts.map((v: number[]) => Math.hypot(v[0]!, v[1]!, v[2]!)));
  expect(r1).toBeLessThanOrEqual(10.000001); // 가린 곳은 그대로 (명령도 없음)
  expect(await undoEnabled()).toBe(before);
  await page.keyboard.press('Alt+m'); // 마스크 지우기
  await stroke();
  const [dl2] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const r2 = Math.max(...JSON.parse(readFileSync((await dl2.path())!, 'utf8')).model.objects[0].polymesh.verts.map((v: number[]) => Math.hypot(v[0]!, v[1]!, v[2]!)));
  expect(r2).toBeGreaterThan(10.05);
});
