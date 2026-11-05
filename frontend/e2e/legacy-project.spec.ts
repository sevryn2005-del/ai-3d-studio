/**
 * 구버전 프로젝트 호환성: shared/samples 의 실제 구버전 파일(복사본)을 열고 → 편집 → 저장 → 다시 열기.
 * 원본 샘플 파일은 건드리지 않는다 (복사본으로만 작업).
 */
import { copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test, type Page } from '@playwright/test';

const SAMPLE = join(dirname(fileURLToPath(import.meta.url)), '../../shared/samples/project-v1-e0ac5e7.ai3d');

test.beforeEach(async ({ page }) => {
  // 파일 선택 창/다운로드 방식으로 (File System Access API 는 Window.prototype 에 있어 인스턴스 속성으로 가린다)
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
});

async function open(page: Page, file: string) {
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '열기' }).click()]);
  await chooser.setFiles(file);
}

async function save(page: Page): Promise<string> {
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  return readFileSync((await download.path())!, 'utf8');
}

test('구버전(e0ac5e7) 파일: 열기 → 그대로 저장 → 다시 열기, 모델이 바뀌지 않는다', async ({ page }, info) => {
  const original = readFileSync(SAMPLE, 'utf8');
  const copy = info.outputPath('기준 판 v1.ai3d');
  copyFileSync(SAMPLE, copy);

  await page.goto('/');
  await open(page, copy);
  await expect(page.getByTestId('project-name')).toHaveText('기준 판 v1');
  await expect(page.locator('.object-list li')).toHaveText([/구멍 뚫린 판/, /기준 판\s*60×40×8/, /구멍\s*Ø6×10/, /손잡이\s*Ø12/]);
  await expect(page.getByTestId('print-check')).toHaveText('출력 검사 ✓', { timeout: 20_000 });

  const saved = await save(page);
  // 저장은 최신 형식(v3)으로: 객체는 그대로, 스케치 없음 (v1 → v2 → v3 마이그레이션)
  const v1 = JSON.parse(original).model;
  expect(JSON.parse(saved).formatVersion).toBe(11);
  expect(JSON.parse(saved).model).toEqual({ ...v1, schemaVersion: 11, sketches: [] });

  const resaved = info.outputPath('다시 저장.ai3d');
  writeFileSync(resaved, saved);
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await open(page, resaved);
  await expect(page.locator('.object-list li')).toHaveCount(4);
  expect(readFileSync(SAMPLE, 'utf8')).toBe(original); // 원본 샘플은 그대로
});

test('구버전 파일을 열어 편집(이동) → 저장 → 다시 열면 편집이 유지된다', async ({ page }, info) => {
  const copy = info.outputPath('기준 판 v1.ai3d');
  copyFileSync(SAMPLE, copy);
  await page.goto('/');
  await open(page, copy);

  await page.locator('[data-object-id="knob"]').click();
  const x = page.locator('fieldset', { hasText: /^위치/ }).getByLabel('X', { exact: true });
  await x.fill('75');
  await x.press('Enter');
  const saved = JSON.parse(await save(page));
  expect(saved.model.objects.find((o: { id: string }) => o.id === 'knob').transform).toEqual({ position: [75, 0, 0], rotation: [0, 0, 30] });

  const resaved = info.outputPath('편집본.ai3d');
  writeFileSync(resaved, JSON.stringify(saved));
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await open(page, resaved);
  await page.locator('[data-object-id="knob"]').click();
  await expect(x).toHaveValue('75');
});

const SAMPLE_V2 = join(dirname(fileURLToPath(import.meta.url)), '../../shared/samples/project-v2-plate.ai3d');

test('v2 기준 판 샘플: 열기 → 출력 검사 ✓ → 원본 폭 수정 → 저장 → 다시 열기', async ({ page }, info) => {
  const copy = info.outputPath('기준 판 v2.ai3d');
  copyFileSync(SAMPLE_V2, copy);
  await page.goto('/');
  await open(page, copy);
  await expect(page.locator('[aria-label="객체 목록"] li')).toHaveText([/구멍 뚫린 판/, /기준 판\s*80×40×4/, /관통 구멍\s*Ø6×6/]);
  await expect(page.getByTestId('print-check')).toHaveText('출력 검사 ✓', { timeout: 20_000 });

  await page.locator('[data-object-id="plate"]').click();
  const w = page.getByTestId('dim-r1.width');
  await w.fill('100');
  await w.press('Enter');
  await expect(page.locator('[data-object-id="plate"]')).toContainText('100×40×4');
  const saved = JSON.parse(await save(page));
  expect(saved.model.sketches[0].dimensions[0].value).toBe(100);

  const resaved = info.outputPath('기준 판 v2 편집.ai3d');
  writeFileSync(resaved, JSON.stringify(saved));
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await open(page, resaved);
  await expect(page.locator('[data-object-id="plate"]')).toContainText('100×40×4');
});

test('스케치 참조가 깨진 v2 파일은 열지 않고 현재 작업을 유지한다', async ({ page }, info) => {
  const broken = JSON.parse(readFileSync(SAMPLE_V2, 'utf8'));
  broken.model.sketches = broken.model.sketches.slice(1); // sk_plate 제거 → plate 의 참조가 깨짐
  const file = info.outputPath('깨진 판.ai3d');
  writeFileSync(file, JSON.stringify(broken));
  await page.goto('/');
  await open(page, file);
  await expect(page.getByRole('alert')).toContainText('존재하지 않는 스케치');
  await expect(page.locator('[aria-label="객체 목록"] li')).toHaveText([/큐브\s*20×20×20/]);
});
