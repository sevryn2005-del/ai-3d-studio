/**
 * 사람이 만나는 오류를 알아듣게: 숫자 칸 단위·계산식, 읽을 수 없는 값 안내, 거부된 명령 안내 상자,
 * 화면 일부 고장 → 그 자리 안내 카드 + 다시 그리기 (앱 전체는 멀쩡).
 */
import { expect, test, type Page } from '@playwright/test';

const box = async (page: Page) => (await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects.find((o) => o.id === 'box_1');

test('친절한 오류 처리: 숫자 칸·안내 상자·고장 난 화면 복구', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.locator('[data-object-id="box_1"]').click();
  const width = page.getByTestId('param-width');

  // 1. 단위·계산식: "5cm" → 50, "20*2+5" → 45 (칸 아래에 바뀐 결과)
  await width.fill('5cm');
  await width.press('Enter');
  await expect(width).toHaveValue('50');
  await expect(page.getByTestId('param-width-message')).toContainText('cm → mm');
  await width.fill('20*2+5');
  await width.press('Enter');
  await expect(width).toHaveValue('45');
  await expect(page.getByTestId('param-width-message')).toContainText('= 45');

  // 2. 읽을 수 없는 값 → 원래 값 그대로 + 이유
  await width.fill('abc');
  await width.press('Enter');
  await expect(width).toHaveValue('45');
  await expect(page.getByTestId('param-width-message')).toContainText('원래 값(45)으로 두었습니다');

  // 3. 범위를 벗어난 값 → 안내 상자 (항목 이름 + 설계는 그대로), 같은 오류는 ×2 로 합침
  await width.fill('0');
  await width.press('Enter');
  const card = page.getByTestId('notice-card').last();
  await expect(card.getByTestId('notice-hint')).toContainText("'너비'");
  await expect(card.getByTestId('notice-hint')).toContainText('설계는 바뀌지 않았습니다');
  await width.fill('0');
  await width.press('Enter');
  await expect(card).toContainText('×2');
  expect((await page.evaluate(() => window.__AI3D_DEV__!.scene())).objects.find((o) => o.id === 'box_1')).toBeTruthy();
  await card.getByRole('button', { name: '닫기' }).click();
  await expect(page.getByTestId('notice-card')).toHaveCount(0);

  // 4. 속성 패널이 고장 나도 그 자리에 안내 카드, 뷰포트·도구 막대는 그대로 → 다시 그리기
  await page.evaluate(() => window.__AI3D_DEV__!.crash());
  await expect(page.getByTestId('crash-card')).toContainText('피처 트리·속성');
  await expect(page.getByRole('tab', { name: '스케치' })).toBeVisible();
  await expect(page.getByTestId('notice-card').last()).toContainText('예상하지 못한 문제');
  await page.getByTestId('crash-retry').click();
  await expect(page.getByTestId('crash-card')).toHaveCount(0);
  await expect(page.getByTestId('param-width')).toBeVisible();
  expect((await box(page))).toBeTruthy();
});
