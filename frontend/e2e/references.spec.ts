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
  expect(saved.formatVersion).toBe(34);
  expect(saved.model.references.map((r: { id: string; type: string }) => [r.id, r.type])).toEqual([
    ['ref_plane_1', 'plane'],
    ['ref_axis_1', 'axis'],
  ]);
  expect(saved.model.references[1]).toMatchObject({ origin: [0, 0, 0], direction: [0, 0, 1] });
});
