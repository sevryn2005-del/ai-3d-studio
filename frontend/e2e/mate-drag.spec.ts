/** 메이트 지키며 끌기: 큐브 윗면 ↔ 뚜껑 바닥 일치 → 위·옆으로 끌면 옆으로만 미끄러진다 (화면 메시도 그 자리) */
import { expect, test } from '@playwright/test';

test('메이트 지키며 끌기: 면 위로만 미끄러짐', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  const src = async (id: string) => (await page.evaluate(() => window.__AI3D_DEV__!.meshSources()))[id];
  await expect.poll(async () => (await src('box_1'))?.source, { timeout: 20_000 }).toBe('server');
  await page.evaluate(() => {
    const d = window.__AI3D_DEV__!;
    d.dispatch({ type: 'create_box', id: 'cap', width: 10, depth: 10, height: 4, position: [40, 0, 3] });
    d.dispatch({ type: 'add_mate', mate: 'coincident', refs: ['box_1.top', 'cap.bottom'] });
  });
  await expect.poll(async () => (await src('cap'))?.min[2], { timeout: 20_000 }).toBeCloseTo(20, 3);
  await page.getByRole('tab', { name: '조립품' }).click();
  await page.getByTestId('cmd-mate').click();
  const toggle = page.getByTestId('mate-drag');
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  // 기즈모가 보내는 것과 같은 명령: X 로 25, 위로 60 → 위는 막히고 옆만
  await page.evaluate(() => window.__AI3D_DEV__!.dispatch({ type: 'move_with_mates', target: 'cap', position: [65, 0, 80], rotation: [0, 0, 0] }));
  await expect.poll(async () => (await src('cap'))?.min[0], { timeout: 20_000 }).toBeCloseTo(60, 3);
  expect((await src('cap'))!.min[2]).toBeCloseTo(20, 3);
  const cap = (await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects.find((o) => o.id === 'cap')!;
  expect(cap.position[2]).toBeCloseTo(20, 4);
  // 실행 취소 한 번 = 끌기 한 번
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await src('cap'))?.min[0], { timeout: 20_000 }).toBeCloseTo(35, 3);
});
