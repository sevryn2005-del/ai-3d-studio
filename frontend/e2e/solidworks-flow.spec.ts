/**
 * 솔리드웍스식 작업 흐름 (실제 마우스·키보드, CAD 엔진 = 로컬 서버):
 * 스케치 탭 → 스케치 → 뷰포트에서 기준 평면 클릭 → 수직 보기 → 사각형 → 피처 탭 → 돌출 보스/베이스
 * → 속성 관리자에서 깊이 (미리보기만, 원본 그대로) → ✓ 확정 = 명령 1건 → 표준 보기 단축키 → 마우스 방식 전환
 */
import { expect, test, type Page } from '@playwright/test';

const scene = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());
const cameraDir = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.cameraDir());
const at = (page: Page, x: number, y: number, z = 0) => page.evaluate(([x, y, z]) => window.__AI3D_DEV__!.project(x!, y!, z!), [x, y, z]);

async function near(page: Page, dir: number[]) {
  await expect
    .poll(async () => {
      const d = await cameraDir(page);
      return Math.max(...d.map((v, i) => Math.abs(v - dir[i]!))) < 0.02 ? 'ok' : d.join(',');
    })
    .toBe('ok');
}

test('스케치 → 평면 클릭 → 사각형 → 돌출 보스/베이스 → 속성 관리자 ✓ → 표준 보기', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '삭제', exact: true }).click(); // 기본 큐브 삭제 → 빈 화면

  // 아무것도 고르지 않고 "스케치" → 기준 평면 3개가 뜨고 안내
  await page.getByRole('tab', { name: '스케치' }).click();
  await page.getByTestId('cmd-sketch').click();
  await expect(page.getByText('스케치할 평면을 클릭하세요')).toBeVisible();

  // 빈 모델: 평면은 40mm, 등각 보기로 셋 다 보이고 이름표가 붙는다
  await expect(page.locator('.plane-label', { hasText: '윗면' })).toBeVisible();
  await near(page, [-0.577, 0.577, -0.577]);
  await page.screenshot({ path: 'test-results/sw-plane-pick.png' });
  // 윗면(XY) 클릭: 다른 기준 평면에 가리지 않는 점 (+X, −Y 사분면)
  const p = await at(page, 12, -12, 0);
  await page.mouse.click(p.x, p.y);
  await expect(page.getByTestId('sketch-state')).toContainText('비어 있음');
  await near(page, [0, 0, -1]); // 스케치에 수직 = 위에서 내려다봄

  // 사각형 그리기 (드래그)
  await page.keyboard.press('r');
  const a = await at(page, -15, -10);
  const b = await at(page, 15, 10);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 8 });
  await page.mouse.up();
  await expect(page.getByTestId('dim-r1.width')).toHaveValue('30');
  await page.keyboard.press('Escape'); // 그리기 끝, 스케치 선택 유지
  await expect(page.getByTestId('sketch-state')).toContainText(/정의/);

  // 피처 → 돌출 보스/베이스: 속성 관리자, 확정 전에는 원본 그대로
  const before = await scene(page);
  await page.getByRole('tab', { name: '피처' }).click();
  await page.getByRole('button', { name: /돌출 보스/ }).click();
  await expect(page.getByTestId('property-manager')).toBeVisible();
  await page.getByTestId('pm-depth').fill('15');
  await page.getByTestId('pm-depth').press('Enter');
  expect(await scene(page)).toEqual(before);

  // 취소하면 아무 일도 없다
  await page.getByTestId('pm-cancel').click();
  await expect(page.getByTestId('property-manager')).toBeHidden();
  expect(await scene(page)).toEqual(before);

  // 다시 열고 뷰포트 오른쪽 위 ✓ 로 확정 → 명령 1건
  await page.getByRole('button', { name: /돌출 보스/ }).click();
  await page.getByTestId('pm-depth').fill('15');
  await page.getByTestId('pm-depth').press('Enter');
  await page.screenshot({ path: 'test-results/sw-property-manager.png' });
  await page.getByTestId('confirm-ok').click();
  await expect(page.getByTestId('property-manager')).toBeHidden();
  const after = await scene(page);
  expect(after.past).toBe(before.past + 1);
  await expect
    .poll(async () => {
      const m = (await page.evaluate(() => window.__AI3D_DEV__!.meshSources()))['extrude_1'];
      return m && { source: m.source, min: m.min, max: m.max };
    }, { timeout: 20_000 })
    .toEqual({ source: 'server', min: [-15, -10, 0], max: [15, 10, 15] });

  // 한 번의 실행 취소로 돌출 전체가 사라진다
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await scene(page)).objects.length).toBe(before.objects.length);
  await page.keyboard.press('Control+y');

  // 표준 보기 단축키 (솔리드웍스: Ctrl+1 정면, Ctrl+5 윗면, Ctrl+7 등각)
  await page.locator('canvas').first().click({ position: { x: 5, y: 5 } }).catch(() => {});
  await page.keyboard.press('Control+1');
  await near(page, [0, 1, 0]); // 정면 = −Y 쪽에서 +Y 방향으로 봄
  await page.keyboard.press('Control+5');
  await near(page, [0, 0, -1]);
  await page.keyboard.press('Control+7');
  await near(page, [-0.577, 0.577, -0.577]);
});

test('마우스 방식: 기본 솔리드웍스식(가운데 버튼 회전), 간편 방식으로 바꾸면 기억된다', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  const toggle = page.getByTestId('mouse-scheme');
  await expect(toggle).toContainText('솔리드웍스식');
  await expect(page.getByTestId('viewport-hint')).toContainText('가운데');

  // 솔리드웍스식: 왼쪽 드래그는 회전하지 않는다 (선택 전용)
  const dir0 = await cameraDir(page);
  const box = (await page.locator('canvas').first().boundingBox())!;
  const drag = async (button: 'left' | 'middle') => {
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.8);
    await page.mouse.down({ button });
    await page.mouse.move(box.x + box.width * 0.35, box.y + box.height * 0.7, { steps: 10 });
    await page.mouse.up({ button });
  };
  await drag('left');
  expect(await cameraDir(page)).toEqual(dir0);
  await drag('middle');
  await expect.poll(() => cameraDir(page)).not.toEqual(dir0);

  // 간편 방식: 왼쪽 드래그 = 회전, 새로 고침 후에도 유지
  await toggle.click();
  await expect(toggle).toContainText('간편');
  const dir1 = await cameraDir(page);
  await drag('left');
  await expect.poll(() => cameraDir(page)).not.toEqual(dir1);
  await page.reload();
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect(page.getByTestId('mouse-scheme')).toContainText('간편');
});
