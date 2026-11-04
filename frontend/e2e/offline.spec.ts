/**
 * 로컬 우선 요구사항 #6: 인터넷이 끊겨도 기본 모델링이 동작한다.
 * DevProbe(개발 전용)에 의존하지 않으므로 로컬 모드 빌드본에도 실행할 수 있다:
 *   E2E_BASE_URL=http://127.0.0.1:8765 npx playwright test e2e/offline.spec.ts
 */
import { expect, test, type Page } from '@playwright/test';

const isLocal = (url: string) => {
  const { protocol, hostname } = new URL(url);
  return ['data:', 'blob:'].includes(protocol) || ['localhost', '127.0.0.1', '[::1]'].includes(hostname);
};

/** localhost 이외의 모든 요청을 차단하고 시도 목록을 기록한다 (= 인터넷 끊김) */
async function goOffline(page: Page) {
  const external: string[] = [];
  await page.context().route('**/*', (route) => {
    const url = route.request().url();
    if (isLocal(url)) return route.continue();
    external.push(url);
    return route.abort('internetdisconnected');
  });
  return external;
}

test('인터넷 없이 편집 → 로컬 CAD 계산 → STL 내보내기, 외부 요청 0건', async ({ page }) => {
  const external = await goOffline(page);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(String(e)));

  await page.goto('/');
  await expect(page.getByTestId('server-status')).toHaveText(/서버 연결됨/, { timeout: 20_000 });

  await page.getByRole('button', { name: '+ 원통' }).click();
  await page.locator('[data-object-id="box_1"]').click();
  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');
  await expect(page.locator('.object-list')).toContainText('20×20×50');
  await expect(page.getByTestId('server-evaluation')).toHaveText('서버 검증 ✓', { timeout: 20_000 });

  await page.getByRole('button', { name: '내보내기 ▾' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('menuitem', { name: /^STL/ }).click(),
  ]);
  expect(download.suggestedFilename()).toBe('제목 없음.stl');

  expect(external, '외부 네트워크 요청이 없어야 합니다').toEqual([]);
  expect(errors).toEqual([]);
});

test('로컬 CAD 서버까지 꺼지면 브라우저 엔진으로 전환: 편집·실행 취소·STL/3MF/GLB 내보내기', async ({ page }) => {
  await goOffline(page);
  // 경로가 /api/ 로 "시작하는" 요청만 차단 (glob '**/api/**' 는 개발 모드의 /src/api/client.ts 모듈까지 막는다)
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.abort('connectionrefused'));

  await page.goto('/');
  await expect(page.getByTestId('server-status')).toHaveText(/오프라인/);
  await expect(page.getByTestId('cad-engine')).toHaveText('CAD: 브라우저 엔진');

  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');
  await expect(page.locator('.object-list')).toContainText('20×20×50');
  await expect(page.getByTestId('server-evaluation')).toHaveText('브라우저 계산 ✓', { timeout: 20_000 });
  await page.keyboard.press('Control+z');
  await expect(page.locator('.object-list')).toContainText('20×20×20');

  const menu = page.getByRole('button', { name: '내보내기 ▾' });
  await menu.click();
  await expect(page.getByRole('menuitem', { name: /^STEP/ })).toBeEnabled(); // 브라우저 정밀 엔진(OCCT WASM)으로도 가능
  for (const fmt of ['STL', '3MF', 'GLB']) {
    if (fmt !== 'STL') await menu.click();
    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('menuitem', { name: new RegExp(`^${fmt}`) }).click(),
    ]);
    expect(download.suggestedFilename()).toBe(`제목 없음.${fmt.toLowerCase()}`);
  }
});
