import { readFileSync } from 'node:fs';
import { expect, test } from '@playwright/test';

/** 바이너리 STL → 삼각형 정점 목록 */
function parseStl(buf: Buffer) {
  const count = buf.readUInt32LE(80);
  expect(buf.length).toBe(84 + count * 50);
  const pts: number[][] = [];
  for (let i = 0; i < count; i++) {
    const o = 84 + i * 50 + 12;
    for (let v = 0; v < 3; v++) pts.push([0, 1, 2].map((k) => buf.readFloatLE(o + v * 12 + k * 4)));
  }
  return { count, pts };
}

test('높이 50mm 로 바꾼 뒤 STL 내보내기 → 파일의 실제 높이가 50mm', async ({ page }) => {
  await page.goto('/');
  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');

  const button = page.getByRole('button', { name: '내보내기 ▾' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  await button.click();
  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('menuitem', { name: /^STL/ }).click()]);
  expect(download.suggestedFilename()).toBe('제목 없음.stl');

  const { count, pts } = parseStl(readFileSync((await download.path())!));
  expect(count).toBe(12);
  const zs = pts.map((p) => p[2]!);
  expect(Math.min(...zs)).toBeCloseTo(0, 5);
  expect(Math.max(...zs)).toBeCloseTo(50, 5);
});

test('3MF · STEP · GLB 도 로컬에서 내려받을 수 있다', async ({ page }) => {
  await page.goto('/');
  const button = page.getByRole('button', { name: '내보내기 ▾' });
  await expect(button).toBeEnabled({ timeout: 20_000 });
  const signatures: Record<string, (b: Buffer) => boolean> = {
    '3mf': (b) => b.subarray(0, 2).toString() === 'PK', // ZIP
    step: (b) => b.subarray(0, 12).toString() === 'ISO-10303-21',
    glb: (b) => b.subarray(0, 4).toString() === 'glTF',
  };
  for (const [fmt, check] of Object.entries(signatures)) {
    await button.click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: new RegExp(`^${fmt.toUpperCase()}`) }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`제목 없음.${fmt}`);
    expect(check(readFileSync((await download.path())!))).toBe(true);
  }
});
