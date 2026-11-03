import { expect, test, type Page } from '@playwright/test';

const rot = (page: Page, axis: string) => page.locator('fieldset', { hasText: /^회전/ }).getByLabel(axis, { exact: true });
const pos = (page: Page, axis: string) => page.locator('fieldset', { hasText: /^위치/ }).getByLabel(axis, { exact: true });

test('눕힌 원통이 바닥 아래로 → 오류 → 내보내기 전 확인 → 바닥에 놓기로 해결', async ({ page }) => {
  await page.goto('/');
  const status = page.getByTestId('print-check');
  await expect(status).toHaveText('출력 검사 ✓');

  // 원통 추가 후 X축 90° 회전: 밑면 중심 기준으로 돌아 절반(반지름 10mm)이 바닥 아래로
  await page.getByRole('button', { name: '+ 원통' }).click();
  await rot(page, 'X').fill('90');
  await rot(page, 'X').press('Enter');
  await expect(status).toHaveText('출력 검사: 오류 1', { timeout: 20_000 });

  // 오류가 있으면 내보내기 전에 확인 (취소하면 내보내지 않음)
  await page.getByRole('button', { name: '내보내기 ▾' }).click();
  await page.getByRole('menuitem', { name: /^STL/ }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('바닥 아래로 10mm');
  await dialog.getByRole('button', { name: '취소' }).click();

  // 문제 목록에서 바로 고치기
  await status.click();
  const panel = page.getByRole('dialog', { name: '출력 전 검사' });
  await expect(panel).toContainText("'원통 1'이(가) 바닥 아래로 10mm 내려가 있습니다");
  await panel.getByRole('button', { name: '바닥에 놓기' }).click();
  await expect(status).toHaveText('출력 검사 ✓');
  await expect(pos(page, 'Z')).toHaveValue('10');

  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z'); // 바닥에 놓기도 일반 명령 → 실행 취소 가능
  await expect(status).toHaveText('출력 검사: 오류 1');
});

test('떠 있는 객체와 얇은 벽은 경고, 속성 패널의 바닥에 놓기', async ({ page }) => {
  await page.goto('/');
  await pos(page, 'Z').fill('15');
  await pos(page, 'Z').press('Enter');
  await page.getByTestId('param-depth').fill('0.5');
  await page.getByTestId('param-depth').press('Enter');
  const status = page.getByTestId('print-check');
  await expect(status).toHaveText('출력 검사: 경고 2', { timeout: 20_000 });
  await status.click();
  await expect(page.getByRole('dialog', { name: '출력 전 검사' })).toContainText('0.5mm 는 0.8mm 보다 얇아');
  await page.keyboard.press('Escape'); // 목록만 닫히고 선택은 유지된다
  await expect(page.getByRole('dialog', { name: '출력 전 검사' })).toHaveCount(0);
  await expect(page.locator('.props')).toBeVisible();

  const drop = page.locator('.props').getByRole('button', { name: '바닥에 놓기' });
  await drop.click();
  await expect(pos(page, 'Z')).toHaveValue('0');
  await expect(drop).toBeDisabled();
  await expect(status).toHaveText('출력 검사: 경고 1');
});
