/**
 * 샌드박스 iframe 웹 호스트 시뮬레이션 (예: claude.ai 공유 페이지):
 * - 일반 다운로드 대신 window.claude.use('downloads').save() 만 동작
 * - 파일 선택 API 는 SecurityError, window.confirm 은 항상 false
 */
import { expect, test, type Page } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.route((url) => url.pathname.startsWith('/api/'), (route) => route.abort('connectionrefused'));
  await page.addInitScript(() => {
    const w = window as unknown as { __saves: { filename: string; base64: string }[] };
    w.__saves = [];
    const toB64 = async (data: Blob | Uint8Array | string) => {
      const buf = data instanceof Blob ? new Uint8Array(await data.arrayBuffer()) : typeof data === 'string' ? new TextEncoder().encode(data) : data;
      let s = '';
      buf.forEach((b) => (s += String.fromCharCode(b)));
      return btoa(s);
    };
    (window as unknown as { claude: unknown }).claude = {
      use: async (name: string) =>
        name === 'downloads'
          ? { save: async ({ filename, data }: { filename: string; data: Blob }) => {
              w.__saves.push({ filename, base64: await toB64(data) });
              return { status: 'saved' };
            } }
          : null,
    };
    const deny = async () => {
      throw new DOMException("Cross origin sub frames aren't allowed to show a file picker.", 'SecurityError');
    };
    window.showSaveFilePicker = deny as never;
    window.showOpenFilePicker = deny as never;
    window.confirm = () => false;
  });
});

const saves = (page: Page) =>
  page.evaluate(() => (window as unknown as { __saves: { filename: string; base64: string }[] }).__saves);

test('호스트 저장: 프로젝트는 .ai3d.json, STL·3MF·GLB 는 ZIP 으로', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('server-evaluation')).toHaveText('브라우저 계산 ✓', { timeout: 20_000 });
  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');

  await page.getByRole('button', { name: '저장', exact: true }).click(); // 파일 선택 창 SecurityError → 호스트 저장
  await expect(page.getByTestId('project-name')).toHaveText('제목 없음');
  const menu = page.getByRole('button', { name: '내보내기 ▾' });
  for (const fmt of ['STL', '3MF', 'GLB']) {
    await menu.click();
    await page.getByRole('menuitem', { name: new RegExp(`^${fmt}`) }).click();
    await expect.poll(async () => (await saves(page)).length).toBeGreaterThan(['STL', '3MF', 'GLB'].indexOf(fmt) + 1);
  }

  const s = await saves(page);
  expect(s.map((x) => x.filename)).toEqual(['제목 없음.ai3d.json', '제목 없음.stl.zip', '제목 없음.3mf.zip', '제목 없음.glb.zip']);
  const project = JSON.parse(Buffer.from(s[0]!.base64, 'base64').toString('utf8'));
  expect(project.model.objects[0].params.height).toBe(50);
  for (const z of s.slice(1)) expect(Buffer.from(z.base64, 'base64').subarray(0, 2).toString()).toBe('PK');
  await expect(page.getByRole('alert')).toHaveCount(0);
});

test('앱 내부 확인 창: window.confirm 이 막힌 환경에서도 새 프로젝트를 확인 후 진행', async ({ page }) => {
  await page.goto('/');
  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');

  await page.getByRole('button', { name: '새 프로젝트' }).click();
  const dialog = page.getByRole('alertdialog');
  await expect(dialog).toContainText('저장하지 않은 변경 사항');
  await dialog.getByRole('button', { name: '취소' }).click();
  await expect(page.locator('.object-list')).toContainText('20×20×50');

  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await page.getByRole('alertdialog').getByRole('button', { name: '새 프로젝트' }).click();
  // 확인하면 시작 화면 → 설계를 고르면 빈 부품
  await expect(page.getByTestId('home')).toBeVisible();
  await page.getByTestId('home-design').click();
  await expect(page.getByTestId('mode-badge')).toHaveText('설계');
  await expect(page.getByTestId('project-name')).toHaveText('제목 없음');
});
