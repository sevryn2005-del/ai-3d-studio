import { expect, test } from '@playwright/test';

test('백엔드 연결 → 모델 변경 시마다 서버 검증', async ({ page }) => {
  const evaluations: unknown[] = [];
  page.on('request', (r) => {
    if (r.url().endsWith('/api/model/evaluate')) evaluations.push(r.postDataJSON());
  });

  await page.goto('/');
  await expect(page.getByTestId('server-status')).toHaveText(/서버 연결됨/);
  await expect(page.getByTestId('server-evaluation')).toHaveText('서버 검증 ✓');

  // 치수 변경 → 변경된 설계 원본이 서버로 전송되고 다시 통과
  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');
  await expect(page.getByTestId('server-evaluation')).toHaveText('서버 검증 ✓');
  await expect
    .poll(() => evaluations.some((m) => JSON.stringify(m).includes('"height":50')))
    .toBe(true);
});

test('연속 편집은 디바운스되어 마지막 상태만 검증 요청된다', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('server-evaluation')).toHaveText('서버 검증 ✓');

  let count = 0;
  page.on('request', (r) => r.url().endsWith('/api/model/evaluate') && count++);
  for (const label of ['원통', '구', '원뿔', '박스']) {
    await page.getByRole('button', { name: `+ ${label}` }).click();
  }
  await expect(page.getByTestId('server-evaluation')).toHaveText('서버 검증 ✓');
  await page.waitForTimeout(600);
  expect(count).toBeLessThanOrEqual(2);
});
