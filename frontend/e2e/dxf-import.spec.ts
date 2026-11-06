/**
 * DXF 가져오기: 툴바 "가져오기"로 DXF 도면 → XY 평면 새 스케치 (닫힌 윤곽 = 다각형, 원 = 원) → 영역 돌출.
 * 스케치 속성의 "DXF 가져오기"는 고른 스케치에 더한다. 각각 실행 취소 1번.
 */
import { expect, test, type Page } from '@playwright/test';

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const sketches = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene().sketches);

const dxf = (entities: (string | number)[][]) =>
  ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES', ...entities.flatMap((e) => e.map(String)), '0', 'ENDSEC', '0', 'EOF'].join('\n');

// 40×30 판 (오른쪽 변은 볼록한 호) + 지름 8 구멍
const PLATE = dxf([
  [0, 'LWPOLYLINE', 8, '0', 90, 4, 70, 1, 10, -20, 20, -15, 10, 20, 20, -15, 42, 0.3, 10, 20, 20, 15, 10, -20, 20, 15],
  [0, 'CIRCLE', 8, '0', 10, 0, 20, 0, 40, 4],
]);
const SLOT = dxf([
  [0, 'LINE', 10, -5, 20, 20, 11, 5, 21, 20],
  [0, 'ARC', 10, 5, 20, 22, 40, 2, 50, 270, 51, 90],
  [0, 'LINE', 10, 5, 20, 24, 11, -5, 21, 24],
  [0, 'ARC', 10, -5, 20, 22, 40, 2, 50, 90, 51, 270],
]);

test('DXF 가져오기 → 새 스케치 → 영역 돌출, 스케치에 더 가져오기', async ({ page }) => {
  test.setTimeout(90_000);
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await expect.poll(async () => (await sources(page)).box_1?.source, { timeout: 20_000 }).toBeTruthy();
  await page.getByRole('button', { name: '삭제', exact: true }).click();

  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-mesh').click()]);
  await chooser.setFiles({ name: 'plate.dxf', mimeType: 'image/vnd.dxf', buffer: Buffer.from(PLATE) });
  await expect(page.getByTestId('notice')).toContainText('닫힌 윤곽 1 · 원 1');
  const sk = (await sketches(page)).find((s) => s.entities.some((e) => e.type === 'polygon'))!;
  expect(sk.entities.map((e) => e.type).sort()).toEqual(['circle', 'polygon']);

  // 영역(판 − 구멍) 돌출: 오른쪽 변의 호가 x 20 보다 튀어나온다
  await page.getByTestId('add-region').click();
  await page.getByTestId('extrude-region1').click();
  await expect.poll(async () => (await sources(page)).extrude_1?.max[0] ?? 0, { timeout: 30_000 }).toBeGreaterThan(22);
  const e = (await sources(page)).extrude_1!;
  expect(e.min[0]).toBeCloseTo(-20, 2);
  expect(e.max[1]! - e.min[1]!).toBeCloseTo(30, 2);

  // 스케치 속성에서 슬롯 DXF 를 더 가져오기 (선·호 4개가 이어져 닫힌 윤곽 하나)
  await page.locator(`[data-sketch-id="${sk.id}"]`).click();
  const [c2] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('import-dxf').click()]);
  await c2.setFiles({ name: 'slot.dxf', mimeType: 'image/vnd.dxf', buffer: Buffer.from(SLOT) });
  await expect(page.getByTestId('notice')).toContainText('slot.dxf: 닫힌 윤곽 1');
  await expect.poll(async () => (await sketches(page)).find((s) => s.id === sk.id)!.entities.length).toBe(4); // 다각형·원·영역 + 슬롯
  await page.keyboard.press('Control+z');
  await expect.poll(async () => (await sketches(page)).find((s) => s.id === sk.id)!.entities.length).toBe(3);
});
