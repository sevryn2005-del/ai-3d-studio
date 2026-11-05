/**
 * 스케치 화면 (종이·격자·스냅): 스케치 중에만 종이·원점·설정 막대가 보이고,
 * 점 스냅(끝점)·정렬 스냅(수평)이 격자 스냅을 꺼도 정확한 좌표를 준다. 설정은 이 브라우저에 남는다.
 */
import { expect, test } from '@playwright/test';

test.use({ storageState: { cookies: [], origins: [] } });

test('스케치 종이·격자·끝점 스냅·수평 정렬·설정 유지', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-design').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect(page.getByTestId('sketch-options')).toHaveCount(0); // 스케치 전에는 없음
  await page.getByTestId('guide-start-sketch').click();
  await page.locator('[data-plane="XY"]').click();
  await expect(page.getByTestId('sketch-options')).toBeVisible();
  await expect(page.getByTestId('sketch-grid-scale')).toContainText('칸');

  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  const drag = async (from: [number, number], to: [number, number]) => {
    const a = await at(...from);
    const b = await at(...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
  };
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByRole('button', { name: /^사각형/ }).click();
  await page.waitForTimeout(500); // 수직 보기 카메라 이동
  await drag([-20, -10], [20, 10]);

  // 격자 스냅을 끄고 모서리 근처를 가리키면 끝점에 정확히 붙는다
  await page.getByTestId('sketch-opt-gridSnap').click();
  await expect(page.getByTestId('sketch-opt-gridSnap')).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: /^원/ }).first().click();
  const near = await at(19.7, 10.3);
  await page.mouse.move(near.x, near.y, { steps: 3 });
  await expect(page.getByTestId('snap-hud')).toHaveAttribute('data-snap', 'endpoint');
  await expect(page.getByTestId('snap-hud')).toContainText('끝점');
  // 원: 모서리(끝점)에서 시작
  await drag([19.7, 10.3], [25.3, 10.4]);
  const sketches = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches;
  expect(sketches[0]!.entities.find((e) => e.type === 'circle')!.center).toEqual([20, 10]);

  // 사각형 윗변·원 중심과 같은 높이(v = 10)로 가면 수평 정렬 안내
  const side = await at(-28.4, 9.7);
  await page.mouse.move(side.x, side.y, { steps: 3 });
  await expect(page.getByTestId('snap-hud')).toContainText('수평 정렬');
  await expect(page.getByTestId('snap-hud')).toContainText('10');

  // 종이 끄기 → 새로 고침 후에도 유지
  await page.getByTestId('sketch-opt-paper').click();
  await expect(page.getByTestId('sketch-opt-paper')).toHaveAttribute('aria-pressed', 'false');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('ai3d.sketchView') ?? '{}'))).toMatchObject({ paper: false, gridSnap: false });

  // 그리기를 끝내고 스케치 선택을 풀면 종이·막대가 사라진다
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('sketch-options')).toHaveCount(0);
});

test('숫자로 길이 입력 + 자동 구속: 원점에서 20×10 사각형 다각형 → 완전 정의', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-design').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-start-sketch').click();
  await page.locator('[data-plane="XY"]').click();
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByRole('button', { name: /^다각형/ }).click();
  await page.waitForTimeout(500);
  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  // 원점 근처 클릭 → 원점에 붙음 (고정)
  const o = await at(0.3, -0.2);
  await page.mouse.click(o.x, o.y);
  // 20 Tab 0 Enter → (20, 0) / 10 Tab 90 → (20, 10) / 20 Tab 180 → (0, 10)
  for (const [len, ang] of [['20', '0'], ['10', '90'], ['20', '180']]) {
    await page.keyboard.type(len!);
    await expect(page.getByTestId('typed-input')).toContainText(len!);
    await page.keyboard.press('Tab');
    await page.keyboard.type(ang!);
    await page.keyboard.press('Enter');
    await expect(page.getByTestId('typed-input')).toHaveCount(0);
  }
  await page.keyboard.press('Enter'); // 닫기
  await expect(page.getByTestId('notice')).toContainText('자동 구속');
  const poly = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches[0]!.entities[0]!;
  expect(poly.type).toBe('polygon');
  await page.keyboard.press('Escape'); // 그리기 끝 (스케치는 선택된 채)
  // 고정 + 수평·수직 4 + 길이 → 완전 정의
  await expect(page.locator('footer.statusbar')).toContainText('완전 정의');

  // 사각형 도구: 숫자로 폭·높이 (커서 위치가 모서리)
  await page.getByRole('button', { name: /^사각형/ }).click();
  const c = await at(30, 0);
  await page.mouse.move(c.x, c.y, { steps: 2 });
  await page.keyboard.type('15');
  await page.keyboard.press('Tab');
  await page.keyboard.type('8');
  await page.keyboard.press('Enter');
  const ents = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches[0]!.entities;
  expect(ents.find((e) => e.type === 'rectangle')!.center).toEqual([37.5, 4]);
});

test('사각형 모서리에 일치, 변 가운데에 중간점 구속이 자동으로', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-design').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-start-sketch').click();
  await page.locator('[data-plane="XY"]').click();
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByRole('button', { name: /^사각형/ }).click();
  await page.waitForTimeout(500);
  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  const a = await at(-20, -10);
  const b = await at(20, 10);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  // 경로: 오른쪽 위 모서리 근처 → 오른쪽 변 가운데 근처 → 바깥 점 → Enter
  await page.getByRole('button', { name: /^경로/ }).click();
  for (const [x, y, snap] of [[19.6, 10.4, 'endpoint'], [20.3, 0.4, 'midpoint']] as const) {
    const p = await at(x, y);
    await page.mouse.move(p.x, p.y, { steps: 3 });
    await expect(page.getByTestId('snap-hud')).toHaveAttribute('data-snap', snap);
    await page.mouse.click(p.x, p.y);
  }
  const q = await at(31.2, -6.3);
  await page.mouse.click(q.x, q.y);
  await page.keyboard.press('Enter');
  await expect(page.getByTestId('notice')).toContainText('자동 구속');
  const sk = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches[0]!;
  const path = sk.entities.find((e) => e.type === 'path')!;
  expect(sk.constraints).toEqual(
    expect.arrayContaining([
      { type: 'coincident', refs: [`${path.id}.p0`, 'r1.p2'] },
      { type: 'midpoint', refs: [`${path.id}.p1`, 'r1.e1'] },
    ]),
  );
});

test('꼭짓점 끌기: 사각형 모서리를 끌면 치수를 지키며 옮겨지고, 구속·치수 기호가 보인다', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-design').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-start-sketch').click();
  await page.locator('[data-plane="XY"]').click();
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByRole('button', { name: /^사각형/ }).click();
  await page.waitForTimeout(500);
  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  const drag = async (from: [number, number], to: [number, number]) => {
    const a = await at(...from);
    const b = await at(...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 8 });
    await page.mouse.up();
  };
  await drag([-20, -10], [20, 10]);
  await page.keyboard.press('Escape'); // 그리기만 끝 (스케치는 선택된 채)
  await expect(page.getByTestId('sketch-badge').filter({ hasText: '40' })).toHaveCount(1);
  await expect(page.getByTestId('sketch-badge').filter({ hasText: '20' })).toHaveCount(1);
  const center = async () => (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches[0]!.entities[0]!.center;
  expect(await center()).toEqual([0, 0]);
  // 오른쪽 위 모서리 (20, 10) → (25, 15): 폭·높이는 그대로, 사각형이 옮겨진다
  await drag([20, 10], [25, 15]);
  await expect.poll(center).toEqual([5, 5]);
  await page.keyboard.press('Control+z');
  await expect.poll(center).toEqual([0, 0]);
  // 구속 표시 끄기
  await page.getByTestId('sketch-opt-relations').click();
  await expect(page.getByTestId('sketch-badge')).toHaveCount(0);
});

test('스케치 대칭 복사·직선 패턴 (속성 패널), 실행 취소 1번', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-design').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-start-sketch').click();
  await page.locator('[data-plane="XY"]').click();
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByRole('button', { name: /^사각형/ }).click();
  await page.waitForTimeout(500);
  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  const a = await at(10, 0);
  const b = await at(20, 10);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await page.keyboard.press('Escape');
  const centers = async () => (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches[0]!.entities.map((e) => e.center);

  await page.getByTestId('copy-pick-r1').check();
  await page.getByTestId('copy-run').click(); // 기본: 세로 축 대칭
  await expect.poll(centers).toEqual([[15, 5], [-15, 5]]);

  await page.getByTestId('copy-mode').selectOption('linear');
  await page.getByTestId('copy-du').fill('0');
  await page.getByTestId('copy-du').press('Enter');
  await page.getByTestId('copy-dv').fill('20');
  await page.getByTestId('copy-dv').press('Enter');
  await page.getByTestId('copy-run').click(); // r1 만 (개수 3 = 원본 + 2)
  await expect.poll(centers).toEqual([[15, 5], [-15, 5], [15, 25], [15, 45]]);
  await page.keyboard.press('Control+z'); // 패턴 전체가 한 번에
  await expect.poll(centers).toEqual([[15, 5], [-15, 5]]);
});

test('잘라내기·연장: 사각형을 지나는 경로의 가운데 조각 지우기 → 끝을 원까지 늘이기', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.getByTestId('home-design').click();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByTestId('guide-start-sketch').click();
  await page.locator('[data-plane="XY"]').click();
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.waitForTimeout(500);
  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  const drag = async (from: [number, number], to: [number, number]) => {
    const a = await at(...from);
    const b = await at(...to);
    await page.mouse.move(a.x, a.y);
    await page.mouse.down();
    await page.mouse.move(b.x, b.y, { steps: 6 });
    await page.mouse.up();
  };
  const click = async (x: number, y: number) => {
    const p = await at(x, y);
    await page.mouse.click(p.x, p.y);
  };
  await page.getByRole('button', { name: /^사각형/ }).click();
  await drag([-10, -5], [10, 5]);
  await page.getByRole('button', { name: /^원/ }).first().click();
  await drag([30, 8], [35, 8]); // 지름 10 원, 중심 (30, 8) — x = 25..35
  await page.getByRole('button', { name: /^경로/ }).click();
  await click(-20, 8.3);
  await click(20, 8.3);
  await page.keyboard.press('Enter');
  const paths = async () =>
    (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches[0]!.entities.filter((e) => e.type === 'path').length;
  expect(await paths()).toBe(1);
  // 경로가 사각형 윗변(y = 5) 위에 있으니, 대신 사각형 안쪽을 지나는 세로 경로로 확인
  await click(0, -20);
  await click(0, 20);
  await page.keyboard.press('Enter');
  expect(await paths()).toBe(2);

  await page.getByTestId('cmd-trim').click();
  const mid = await at(0.2, 0);
  await page.mouse.move(mid.x, mid.y, { steps: 3 });
  await expect(page.locator('[data-testid="viewport-hint"]')).toContainText('지울 조각');
  await page.mouse.click(mid.x, mid.y); // 사각형 안 조각 (y = −5..5) 지움 → 세로 경로가 두 조각
  await expect.poll(paths).toBe(3);

  await page.getByTestId('cmd-extend').click();
  await click(20, 8.3); // 가로 경로 오른쪽 끝 → 원 왼쪽(x = 25)까지
  const rightEnd = async () => {
    const e = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).sketches[0]!.entities;
    const horizontal = e.find((x) => x.type === 'path' && x.points!.every((p) => Math.abs(p[1]! - 8.3) < 0.5))!;
    return Math.max(...horizontal.points!.map((p) => p[0]!));
  };
  await expect.poll(rightEnd).toBeCloseTo(25 + 5 - Math.sqrt(25 - 0.3 * 0.3) , 1); // 원 왼쪽 가장자리 (y = 8.3 높이)
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z'); // 연장 취소
  await page.keyboard.press('Control+z'); // 잘라내기 취소
  await expect.poll(paths).toBe(2);
});
