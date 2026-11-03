/**
 * 다음 변경 단위의 전체 흐름 (실제 마우스·키보드, CAD 엔진 = 로컬 서버):
 * 치수형 사각형 → 4mm 돌출 → 원본 폭 80 → 재계산 → 관통 구멍 → 저장 → 새 프로젝트 → 다시 열기 → 폭 90 → 재계산 → STL 검사
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
});

const sources = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.meshSources());
const scene = (page: Page) => page.evaluate(() => window.__AI3D_DEV__!.scene());

async function expectMesh(page: Page, id: string, min: number[], max: number[]) {
  await expect
    .poll(async () => {
      const m = (await sources(page))[id];
      return m && { source: m.source, min: m.min, max: m.max };
    }, { timeout: 20_000 })
    .toEqual({ source: 'server', min, max });
}

async function setField(page: Page, testId: string, value: string) {
  const f = page.getByTestId(testId);
  await f.fill(value);
  await f.press('Enter');
}

async function open(page: Page, file: string) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '열기' }).click()]);
  await chooser.setFiles(file);
}

function parseStl(buf: Buffer) {
  const count = buf.readUInt32LE(80);
  expect(buf.length).toBe(84 + count * 50);
  const pts: number[][] = [];
  let volume = 0;
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50 + 12;
    const [a, b, c] = [0, 1, 2].map((v) => [0, 1, 2].map((k) => buf.readFloatLE(o + v * 12 + k * 4))) as [number[], number[], number[]];
    pts.push(a, b, c);
    volume += a[0]! * (b[1]! * c[2]! - b[2]! * c[1]!) - a[1]! * (b[0]! * c[2]! - b[2]! * c[0]!) + a[2]! * (b[0]! * c[1]! - b[1]! * c[0]!);
  }
  const axis = (k: number) => [Math.min(...pts.map((p) => p[k]!)), Math.max(...pts.map((p) => p[k]!))];
  return { volume: volume / 6, x: axis(0), y: axis(1), z: axis(2) };
}

test('사각형 스케치 → 4mm 돌출 → 폭 80 → 구멍 → 저장·다시 열기 → 폭 90 → STL', async ({ page }, info) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '삭제' }).click(); // 기본 큐브 제거 (box_1 선택 상태)
  await expect(page.locator('[aria-label="객체 목록"] li')).toHaveText(['객체가 없습니다']);

  // 1. 치수형 사각형
  await page.getByRole('button', { name: '+ 사각형 스케치' }).click();
  const props = page.getByTestId('sketch-properties');
  await expect(props).toBeVisible();
  await expect(page.getByTestId('dim-r1.width')).toHaveValue('60');
  await expect(page.getByTestId('dim-r1.height')).toHaveValue('40');
  await expect(page.getByTestId('extrude-distance-r1')).toHaveValue('4');

  // 2. 4mm 돌출 → 돌출 객체가 선택되고 서버 메시 60×40×4
  await page.getByTestId('extrude-r1').click();
  await expect(page.locator('[data-object-id="extrude_1"]')).toContainText('60×40×4');
  await expect(page.getByTestId('param-distance')).toHaveValue('4');
  await expectMesh(page, 'extrude_1', [-30, -20, 0], [30, 20, 4]);
  const before = await scene(page);

  // 3. 원본 폭 수정 (돌출 객체 패널의 윤곽 치수) → 이력 1건, 재계산
  await setField(page, 'dim-r1.width', '80');
  await expect(page.locator('[data-object-id="extrude_1"]')).toContainText('80×40×4');
  await expectMesh(page, 'extrude_1', [-40, -20, 0], [40, 20, 4]);
  const after = await scene(page);
  expect(after.past).toBe(before.past + 1);
  expect(after.command).toEqual({ type: 'set_dimension', sketch: 'sketch_1', dimension: 'r1.width', value: 80 });

  // 4. 관통 구멍 Ø6 at (18, 0) → 판에서 뺀 단일 메시, 출력 검사 통과
  await setField(page, 'hole-x', '18');
  await page.getByTestId('hole-apply').click();
  await expect(page.locator('[data-object-id="cut_1"]')).toBeVisible();
  await expectMesh(page, 'cut_1', [-40, -20, 0], [40, 20, 4]);
  await expect(page.getByTestId('print-check')).toHaveText('출력 검사 ✓', { timeout: 20_000 });

  // 5. 저장 (v2): 스케치·돌출·구멍이 원본 형태로 들어 있다 (메시는 저장하지 않음)
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const saved = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(2);
  expect(saved.model.sketches.map((s: { id: string }) => s.id)).toEqual(['sketch_1', 'sk_hole_1']);
  expect(saved.model.sketches[0].dimensions[0]).toEqual({ id: 'r1.width', entity: 'r1', kind: 'width', value: 80 });
  expect(JSON.stringify(saved)).not.toMatch(/positions|indices|revision|commandId/);
  const file = info.outputPath('기준 판.ai3d');
  writeFileSync(file, JSON.stringify(saved));

  // 6. 새 프로젝트 → 다시 열기 → 폭 90 → 재계산
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await open(page, file);
  await expect(page.getByTestId('project-name')).toHaveText('기준 판');
  await expectMesh(page, 'cut_1', [-40, -20, 0], [40, 20, 4]);
  await page.locator('[data-sketch-id="sketch_1"]').click();
  await setField(page, 'dim-r1.width', '90');
  await expectMesh(page, 'cut_1', [-45, -20, 0], [45, 20, 4]);

  // 7. STL 출력 검사: 90×40×4, 부피 = 판 − 구멍
  const button = page.getByRole('button', { name: '내보내기 ▾' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  const [stl] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^STL/ }).click()]);
  const r = parseStl(readFileSync((await stl.path())!));
  expect(r.x[0]).toBeCloseTo(-45, 4);
  expect(r.x[1]).toBeCloseTo(45, 4);
  expect(r.y).toEqual([expect.closeTo(-20, 4), expect.closeTo(20, 4)]);
  expect(r.z).toEqual([expect.closeTo(0, 4), expect.closeTo(4, 4)]);
  expect(Math.abs(r.volume - (90 * 40 * 4 - Math.PI * 9 * 4)) / (90 * 40 * 4)).toBeLessThan(2e-3);
});

test('엔진 오류에도 설계 원본은 남고, 고치면 다시 계산된다', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '+ 사각형 스케치' }).click();
  await page.getByTestId('extrude-r1').click();
  await expectMesh(page, 'extrude_1', [-30, -20, 0], [30, 20, 4]);

  // 서버를 끊는다 → 치수 변경은 원본에 반영되고, 이전 메시는 유지되며 오류가 표시된다
  await page.route('**/api/model/evaluate', (route) => route.abort());
  await setField(page, 'dim-r1.width', '70');
  await expect(page.locator('[data-object-id="extrude_1"]')).toContainText('70×40×4');
  await expect(page.locator('.statusbar')).toContainText(/연결|오류|실패/, { timeout: 20_000 });

  // 서버가 돌아오면 다음 편집에서 다시 계산된다
  await page.unroute('**/api/model/evaluate');
  await setField(page, 'dim-r1.height', '30');
  await expectMesh(page, 'extrude_1', [-35, -15, 0], [35, 15, 4]);
});
