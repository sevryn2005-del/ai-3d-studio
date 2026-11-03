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
  expect(JSON.parse(saved).model).toEqual(JSON.parse(original).model); // 저장해도 설계 원본은 동일 (마이그레이션 없음)

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
