/**
 * 참조 형상 (형식 v34): 큐브 윗면 세 점 클릭 → 기준 평면 → 그 평면에 스케치, 좌표 입력으로 기준 축, 삭제, 저장 파일
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const at = (page: Page, x: number, y: number, z: number) => page.evaluate(([x, y, z]) => window.__AI3D_DEV__!.project(x!, y!, z!), [x, y, z]);
const model = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());

test('참조 형상: 세 점 기준 평면 → 스케치, 좌표로 기준 축, 삭제·실행 취소, 저장', async ({ page }, info) => {
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect.poll(async () => (await page.evaluate(() => window.__AI3D_DEV__!.meshSources())).box_1?.source, { timeout: 20_000 }).toBe('server');
  await page.getByTestId('cmd-reference').click();
  await expect(page.getByTestId('ref-panel')).toBeVisible();
  await expect(page.getByTestId('ref-create')).toBeDisabled();
  // 큐브 20 윗면 (z = 20) 세 점
  for (const [x, y] of [[-5, -5], [5, -5], [-5, 5]] as const) {
    const p = await at(page, x, y, 20);
    await page.mouse.click(p.x, p.y);
  }
  await expect(page.getByTestId('ref-create')).toBeEnabled();
  await page.screenshot({ path: info.outputPath('ref-pick.png') });
  await page.getByTestId('ref-create').click();
  await expect(page.getByTestId('ref-panel')).toHaveCount(0);
  const tree = page.getByRole('list', { name: '참조 형상' });
  await expect(tree).toContainText('기준 평면 1');

  // 그 평면에 스케치: 고정 위치 평면 (z = 20, 법선 +Z)
  await page.getByTestId('ref-sketch-ref_plane_1').click();
  await expect.poll(async () => (await model(page)).sketches.at(-1)?.plane.type).toBe('frame');
  // 화면 클릭이라 소수점 아래는 조금 다를 수 있다
  const plane = (await model(page)).sketches.at(-1)!.plane as { origin: number[]; normal: number[]; xDir: number[] };
  expect(plane.origin[2]).toBeCloseTo(20, 2);
  expect(plane.normal[2]).toBeCloseTo(1, 4);
  expect(plane.xDir[0]).toBeCloseTo(1, 3);
  await page.keyboard.press('Escape');

  // 좌표 입력으로 기준 축 (원점 → +Z)
  await page.getByTestId('cmd-reference').click();
  await page.getByTestId('ref-type-axis').click();
  await page.getByLabel('첫 점 X').fill('0');
  await page.getByLabel('첫 점 Y').fill('0');
  await page.getByLabel('첫 점 Z').fill('0');
  await page.getByLabel('둘째 점 (방향) X').fill('0');
  await page.getByLabel('둘째 점 (방향) Y').fill('0');
  await page.getByLabel('둘째 점 (방향) Z').fill('30');
  await page.getByTestId('ref-create').click();
  await expect(tree).toContainText('기준 축 1');

  // 삭제 → 실행 취소
  await page.getByTestId('ref-delete-ref_axis_1').click();
  await expect(tree).not.toContainText('기준 축 1');
  await page.keyboard.press('Control+z');
  await expect(tree).toContainText('기준 축 1');

  const [dl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: '저장', exact: true }).click()]);
  const saved = JSON.parse(readFileSync((await dl.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(42);
  expect(saved.model.references.map((r: { id: string; type: string }) => [r.id, r.type])).toEqual([
    ['ref_plane_1', 'plane'],
    ['ref_axis_1', 'axis'],
  ]);
  expect(saved.model.references[1]).toMatchObject({ origin: [0, 0, 0], direction: [0, 0, 1] });
});

for (const engine of ['server', 'browser'] as const) {
  test(`원형 패턴을 기준 축 둘레로 (${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진): 축 (10,0)+Z, 4개 → 반지름 20 원`, async ({ page }) => {
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    const src = async () => await page.evaluate(() => window.__AI3D_DEV__!.meshSources());
    await expect.poll(async () => (await src()).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.evaluate(() => {
      window.__AI3D_DEV__!.dispatch({ type: 'set_transform', target: 'box_1', position: [30, 0, 0] });
      window.__AI3D_DEV__!.dispatch({ type: 'add_reference', reference: { type: 'axis', origin: [10, 0, 0], direction: [0, 0, 1], name: '중심 축' } });
    });
    await page.locator('[data-object-id="box_1"]').click();
    await page.getByTestId('cmd-circular').click();
    await expect.poll(async () => (await src()).pattern_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.getByTestId('pattern-count').fill('4');
    await page.getByTestId('pattern-count').press('Enter');
    await page.getByTestId('pattern-ref-axis').selectOption({ label: '중심 축' });
    // 사본 중심 (30,0) (10,20) (−10,0) (10,−20), 큐브 20 → x −20..40, y −30..30
    await expect.poll(async () => (await src()).pattern_1?.min, { timeout: 20_000 }).toEqual([-20, -30, 0]);
    expect((await src()).pattern_1!.max).toEqual([40, 30, 20]);
    const before = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).past;
    await page.keyboard.press('Control+z'); // 정렬은 실행 취소 1번
    await expect.poll(async () => (await page.evaluate(() => window.__AI3D_DEV__!.scene())).past).toBe(before - 1);
  });
}

test('곡선 패턴 (형식 v35): 경로 그리기 → 곡선 패턴 → 개수·방향 따라 돌리기 → 경로 삭제 막힘', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  const src = async () => await page.evaluate(() => window.__AI3D_DEV__!.meshSources());
  await expect.poll(async () => (await src()).box_1?.source, { timeout: 20_000 }).toBe('server');
  // 선이 없으면 알려 준다
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByTestId('cmd-curve-pattern').click();
  await expect(page.getByRole('alert')).toContainText('선이나 경로를 그리세요');
  await page.evaluate(() => {
    window.__AI3D_DEV__!.dispatch({ type: 'create_sketch', id: 'pc', plane: { type: 'XY', offset: 0 } });
    window.__AI3D_DEV__!.dispatch({ type: 'add_path', sketch: 'pc', id: 'pa', points: [[0, 0], [60, 0], [60, 60]] });
  });
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByTestId('cmd-curve-pattern').click();
  await expect.poll(async () => (await src()).pattern_1?.source, { timeout: 20_000 }).toBe('server');
  // 기본 4개: 길이 120 을 3 등분 → (0,0)(40,0)(60,20)(60,60), 큐브 20
  await expect.poll(async () => (await src()).pattern_1?.max, { timeout: 20_000 }).toEqual([70, 70, 20]);
  await expect(page.getByTestId('pattern-curve-path')).toHaveValue('pc/pa');
  await page.getByTestId('pattern-count').fill('3');
  await page.getByTestId('pattern-count').press('Enter');
  await page.getByTestId('pattern-align').check();
  await expect.poll(async () => (await src()).pattern_1?.min, { timeout: 20_000 }).toEqual([-10, -10, 0]);
  expect((await src()).pattern_1!.max).toEqual([70, 70, 20]);
  // 패턴이 쓰는 경로는 지울 수 없다
  const r = await page.evaluate(() => window.__AI3D_DEV__!.dispatch({ type: 'delete_sketch_entity', sketch: 'pc', entity: 'pa' }) as { ok: boolean });
  expect(r.ok).toBe(false);
});

test('스케치 위치 패턴 (형식 v36): 원 셋 → 원 중심마다 큐브, 원 하나 더 → 다시 계산', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  const src = async () => await page.evaluate(() => window.__AI3D_DEV__!.meshSources());
  await expect.poll(async () => (await src()).box_1?.source, { timeout: 20_000 }).toBe('server');
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByTestId('cmd-sketch-pattern').click();
  await expect(page.getByRole('alert')).toContainText('원을 2개 이상');
  await page.evaluate(() => {
    const d = window.__AI3D_DEV__!.dispatch;
    d({ type: 'create_sketch', id: 'ps', name: '볼트 자리', plane: { type: 'XY', offset: 0 } });
    d({ type: 'add_circle', sketch: 'ps', id: 'c1', center: [0, 0], diameter: 3 });
    d({ type: 'add_circle', sketch: 'ps', id: 'c2', center: [40, 0], diameter: 3 });
    d({ type: 'add_circle', sketch: 'ps', id: 'c3', center: [40, 40], diameter: 3 });
  });
  await page.locator('[data-object-id="box_1"]').click();
  await page.getByTestId('cmd-sketch-pattern').click();
  await expect(page.getByTestId('pattern-sketch')).toHaveValue('ps');
  // 큐브 20, 중심 (0,0)(40,0)(40,40) → x −10..50, y −10..50
  await expect.poll(async () => (await src()).pattern_1?.max, { timeout: 20_000 }).toEqual([50, 50, 20]);
  expect((await src()).pattern_1!.min).toEqual([-10, -10, 0]);
  await page.evaluate(() => window.__AI3D_DEV__!.dispatch({ type: 'add_circle', sketch: 'ps', id: 'c4', center: [-40, 0], diameter: 3 }));
  await expect.poll(async () => (await src()).pattern_1?.min, { timeout: 20_000 }).toEqual([-50, -10, 0]);
});

for (const engine of ['server', 'browser'] as const) {
  test(`평면 자르기·두 조각 (형식 v37, ${engine === 'server' ? 'CadQuery 서버' : '브라우저'} 엔진)`, async ({ page }) => {
    if (engine === 'browser') await page.route((url) => url.pathname.startsWith('/api/'), (r) => r.abort('connectionrefused'));
    await page.goto('/');
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    const src = async () => await page.evaluate(() => window.__AI3D_DEV__!.meshSources());
    await expect.poll(async () => (await src()).box_1?.source, { timeout: 20_000 }).toBe(engine);
    await page.locator('[data-object-id="box_1"]').click();
    await page.getByTestId('cmd-split').click();
    // 큐브 20 (z 0..20) 을 높이 가운데 z = 10 에서 잘라 위쪽
    await expect.poll(async () => (await src()).pattern_1?.min, { timeout: 20_000 }).toEqual([-10, -10, 10]);
    await expect(page.getByTestId('split-offset')).toHaveValue('10');
    await page.getByTestId('split-offset').fill('5');
    await page.getByTestId('split-offset').press('Enter');
    await expect.poll(async () => (await src()).pattern_1?.min, { timeout: 20_000 }).toEqual([-10, -10, 5]);
    // 두 조각: 반대쪽(아래 0..5)을 남긴 객체가 하나 더
    await page.getByTestId('split-both').click();
    await expect.poll(async () => (await src()).pattern_2?.max, { timeout: 20_000 }).toEqual([10, 10, 5]);
    expect((await src()).pattern_2!.min).toEqual([-10, -10, 0]);
    await expect(page.locator('.object-list')).toContainText('(반대쪽)');
    await page.keyboard.press('Control+z'); // 두 조각 만들기는 실행 취소 1번
    await expect.poll(async () => Object.keys(await src())).not.toContain('pattern_2');
    await page.locator('[data-object-id="pattern_1"]').click();
    await page.getByTestId('split-keep').selectOption('negative');
    await expect.poll(async () => (await src()).pattern_1?.max, { timeout: 20_000 }).toEqual([10, 10, 5]);
  });
}
