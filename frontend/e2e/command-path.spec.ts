/**
 * 첫 명령 경로: 이동 기즈모 드래그 → 명령 봉투(commandId, baseRevision, set_transform) → 이력 1건.
 * 편집은 실제 마우스·키보드로 하고, 상태 확인과 재시도·동시 변경 재현에만 개발용 훅을 쓴다.
 */
import { expect, test, type Page } from '@playwright/test';

const scene = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());
const project = (page: Page, x: number, y: number, z: number) =>
  page.evaluate(([x, y, z]) => window.__AI3D_DEV__!.project(x!, y!, z!), [x, y, z]);

/** 선택된 박스(원점)의 X 화살표 손잡이 위치와 화면상 +X 방향 */
async function xHandle(page: Page) {
  const o = await project(page, 0, 0, 0);
  const px = await project(page, 1, 0, 0);
  const len = Math.hypot(px.x - o.x, px.y - o.y);
  const dir = { x: (px.x - o.x) / len, y: (px.y - o.y) / len };
  return { grab: { x: o.x + dir.x * 60, y: o.y + dir.y * 60 }, dir };
}

async function ready(page: Page) {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.waitForTimeout(300);
}

test('드래그: 미리보기 중에는 원본·이력 그대로, 놓으면 이력 1건 → 실행 취소 → 다시 실행 → 재시도는 중복', async ({ page }) => {
  await ready(page);
  const s0 = await scene(page);
  expect(s0).toMatchObject({ revision: 0, past: 0, future: 0 });

  const { grab, dir } = await xHandle(page);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + dir.x * 120, grab.y + dir.y * 120, { steps: 12 });
  // 아직 놓지 않음: 화면에서는 움직이지만 설계 원본·이력·리비전은 그대로
  expect(await scene(page)).toEqual(s0);
  await page.mouse.up();

  await expect.poll(async () => (await scene(page)).revision).toBe(1);
  const s1 = await scene(page);
  expect(s1).toMatchObject({ past: 1, future: 0, baseRevision: 0, command: { type: 'set_transform', target: 'box_1' } });
  expect(s1.commandId).toMatch(/.{8,}/);
  const movedX = s1.objects[0]!.position[0]!;
  expect(movedX).toBeGreaterThan(5);
  expect(Number.isInteger(movedX)).toBe(true); // 1mm 스냅
  const xField = page.locator('fieldset', { hasText: /^위치/ }).getByLabel('X', { exact: true });
  await expect(xField).toHaveValue(String(movedX));

  // 실행 취소 / 다시 실행 (실제 키보드)
  await page.keyboard.press('Control+z');
  await expect(xField).toHaveValue('0');
  expect(await scene(page)).toMatchObject({ revision: 0, past: 0, future: 1 });
  await page.keyboard.press('Control+Shift+z');
  await expect(xField).toHaveValue(String(movedX));
  expect(await scene(page)).toMatchObject({ revision: 1, past: 1, future: 0 });

  // 같은 봉투 재시도(예: 이벤트 중복·네트워크 재전송) → 중복, 아무것도 바뀌지 않음
  const replay = await page.evaluate(
    (env) => window.__AI3D_DEV__!.submit(env),
    { commandId: s1.commandId, baseRevision: s1.baseRevision, command: s1.command },
  );
  expect(replay).toEqual({ status: 'duplicate', revision: 1 });
  expect(await scene(page)).toEqual(s1);

  // 실행 취소한 뒤 재시도해도 다시 적용되지 않는다
  await page.keyboard.press('Control+z');
  expect(await page.evaluate((env) => window.__AI3D_DEV__!.submit(env), { commandId: s1.commandId, baseRevision: 0, command: s1.command }))
    .toMatchObject({ status: 'duplicate' });
  await expect(xField).toHaveValue('0');
});

test('드래그하는 동안 다른 변경이 먼저 적용되면 이 드래그는 반영하지 않고 화면을 원본으로 되돌린다', async ({ page }) => {
  await ready(page);
  const { grab, dir } = await xHandle(page);
  await page.mouse.move(grab.x, grab.y);
  await page.mouse.down();
  await page.mouse.move(grab.x + dir.x * 120, grab.y + dir.y * 120, { steps: 12 });

  // 드래그 중에 다른 경로의 변경이 먼저 커밋됨 (예: AI 응답 적용, 다른 패널의 편집)
  await page.evaluate(() => window.__AI3D_DEV__!.dispatch({ type: 'set_params', target: 'box_1', params: { height: 30 } }));
  const afterOther = await scene(page);
  expect(afterOther).toMatchObject({ revision: 1, past: 1 });
  await page.mouse.up();

  await expect(page.getByRole('alert')).toContainText('다른 변경이 먼저 적용되어');
  expect(await scene(page)).toEqual(afterOther); // 원본·이력 보존 (드래그는 이력에 없음)
  // 화면의 객체도 최신 원본 위치(0,0,0)로 되돌아감
  const box = (await page.evaluate(() => window.__AI3D_DEV__!.meshSources())).box_1!;
  expect(box.min[0]).toBeCloseTo(-10, 3);
  await expect(page.locator('.object-list')).toContainText('20×20×30');
});

test('잘못된 대상·잘못된 봉투·클릭만(움직임 없음)은 원본과 이력을 바꾸지 않는다', async ({ page }) => {
  await ready(page);
  const s0 = await scene(page);
  const ghost = await page.evaluate(() =>
    window.__AI3D_DEV__!.submit({ commandId: 'g1', baseRevision: 0, command: { type: 'set_transform', target: 'ghost', position: [5, 0, 0] } }),
  );
  expect(ghost).toEqual({ status: 'rejected', error: '존재하지 않는 객체입니다: ghost' });
  expect(await page.evaluate(() => window.__AI3D_DEV__!.submit({ commandId: 'g2', command: {} }))).toMatchObject({ status: 'rejected' });
  expect(await scene(page)).toEqual(s0);

  const { grab } = await xHandle(page);
  await page.mouse.click(grab.x, grab.y); // 손잡이 클릭만
  await page.waitForTimeout(200);
  expect(await scene(page)).toEqual(s0);
  await expect(page.locator('.props')).toBeVisible(); // 선택도 유지
});
