import { readFileSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

const listText = (page: Page) => page.locator('.object-list');

async function setHeight(page: Page, v: string) {
  const h = page.getByTestId('param-height');
  await h.fill(v);
  await h.press('Enter');
}

test.describe('파일 선택 창/다운로드 방식 (File System Access API 미지원 브라우저)', () => {
  test.beforeEach(async ({ page }) => {
    // 이 API 는 Window.prototype 에 있으므로 delete 로는 지워지지 않는다 → 인스턴스 속성으로 가린다
    await page.addInitScript(() => {
      for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) {
        Object.defineProperty(window, k, { value: undefined, configurable: true });
      }
    });
  });

  test('저장 → 미저장 표시 → 새 프로젝트 → 열기로 복원', async ({ page }, info) => {
    await page.goto('/');
    await expect(page.getByTestId('project-name')).toHaveText('제목 없음');
    await setHeight(page, '50');
    await expect(page.getByTestId('project-name')).toHaveText('제목 없음 •');
    await expect(page).toHaveTitle('• 제목 없음 — AI 3D Studio');

    const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
    expect(download.suggestedFilename()).toBe('제목 없음.ai3d');
    await expect(page.getByTestId('project-name')).toHaveText('제목 없음');
    const saved = JSON.parse(readFileSync((await download.path())!, 'utf8'));
    expect(saved).toMatchObject({ format: 'ai3d-project', formatVersion: 33, name: '제목 없음' });
    expect(saved.model.objects[0].params.height).toBe(50);

    // 실행 취소 → 미저장, 다시 실행(저장 시점) → 저장됨
    await page.keyboard.press('Control+z');
    await expect(page.getByTestId('project-name')).toHaveText('제목 없음 •');
    await page.keyboard.press('Control+Shift+z');
    await expect(page.getByTestId('project-name')).toHaveText('제목 없음');

    // 새 프로젝트 → 시작 화면 (작업 모드 고르기)
    await page.getByRole('button', { name: '새 프로젝트' }).click();
    await expect(page.getByTestId('home')).toBeVisible();

    // 시작 화면에서 다른 이름의 파일로 열기
    const file = info.outputPath('받침대.ai3d');
    writeFileSync(file, JSON.stringify(saved));
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByTestId('home-open').click()]);
    await chooser.setFiles(file);
    await expect(listText(page)).toContainText('20×20×50');
    await expect(page.getByTestId('project-name')).toHaveText('받침대');
    await expect(page.getByTestId('notice')).toHaveText('열었습니다: 받침대.ai3d');
  });

  test('잘못된 파일은 열지 않고 이유를 알려준다', async ({ page }, info) => {
    await page.goto('/');
    const file = info.outputPath('broken.ai3d');
    writeFileSync(file, '{"format":"ai3d-project","formatVersion":99}');
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByRole('button', { name: '열기' }).click()]);
    await chooser.setFiles(file);
    await expect(page.getByRole('alert')).toContainText('더 새로운 버전');
    await expect(listText(page)).toContainText('20×20×20');
  });
});

test('새로 고침해도 자동 임시 저장으로 작업이 복원된다', async ({ page }) => {
  await page.goto('/');
  await setHeight(page, '42');
  await page.waitForTimeout(1300); // 임시 저장 디바운스 (1초)
  await page.reload();
  await expect(listText(page)).toContainText('20×20×42');
  await expect(page.getByTestId('notice')).toHaveText('이전 작업을 복원했습니다');
  await expect(page.getByTestId('project-name')).toHaveText('제목 없음 •'); // 파일로는 저장 안 됨
});

test('File System Access API: 처음 한 번만 위치를 묻고 이후 같은 파일에 덮어쓴다', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __writes: string[]; __pickerCalls: number };
    w.__writes = [];
    w.__pickerCalls = 0;
    const handle = {
      name: '내 거치대.ai3d',
      createWritable: async () => ({
        write: async (t: string) => void w.__writes.push(t),
        close: async () => {},
      }),
    };
    window.showSaveFilePicker = (async () => {
      w.__pickerCalls++;
      return handle;
    }) as unknown as typeof window.showSaveFilePicker;
  });
  await page.goto('/');
  await setHeight(page, '30');
  await page.getByRole('button', { name: '저장' }).click();
  await expect(page.getByTestId('project-name')).toHaveText('내 거치대');
  await setHeight(page, '35');
  await page.keyboard.press('Control+s');
  await expect(page.getByTestId('project-name')).toHaveText('내 거치대');

  const { writes, pickerCalls } = await page.evaluate(() => {
    const w = window as unknown as { __writes: string[]; __pickerCalls: number };
    return { writes: w.__writes, pickerCalls: w.__pickerCalls };
  });
  expect(pickerCalls).toBe(1);
  expect(writes.map((t) => JSON.parse(t).model.objects[0].params.height)).toEqual([30, 35]);
});

test('저장 중 쓰기가 실패하면 기존 파일은 그대로, 미저장 상태 유지 (임시 사본 폐기)', async ({ page }) => {
  await page.addInitScript(() => {
    const w = window as unknown as { __file: string; __aborted: number; __failNext: boolean };
    w.__file = 'ORIGINAL';
    w.__aborted = 0;
    w.__failNext = false;
    const handle = {
      name: '받침.ai3d',
      // File System Access API 처럼: 임시 사본에 쓰고 close() 때만 원본과 교체
      createWritable: async () => {
        let pending = '';
        return {
          write: async (t: string) => {
            if (w.__failNext) throw new DOMException('디스크 공간 부족', 'QuotaExceededError');
            pending = t;
          },
          close: async () => void (w.__file = pending),
          abort: async () => void w.__aborted++,
        };
      },
    };
    window.showSaveFilePicker = (async () => handle) as unknown as typeof window.showSaveFilePicker;
  });
  await page.goto('/');
  await page.getByRole('button', { name: '저장' }).click(); // 첫 저장 성공
  await expect(page.getByTestId('project-name')).toHaveText('받침');
  const firstSave = await page.evaluate(() => (window as unknown as { __file: string }).__file);
  expect(JSON.parse(firstSave).model.objects[0].params.height).toBe(20);

  const h = page.getByTestId('param-height');
  await h.fill('50');
  await h.press('Enter');
  await page.evaluate(() => ((window as unknown as { __failNext: boolean }).__failNext = true));
  await page.keyboard.press('Control+s');

  await expect(page.getByRole('alert')).toContainText('저장 실패');
  await expect(page.getByTestId('project-name')).toHaveText('받침 •'); // 여전히 미저장
  const state = await page.evaluate(() => {
    const w = window as unknown as { __file: string; __aborted: number };
    return { file: w.__file, aborted: w.__aborted };
  });
  expect(state.file).toBe(firstSave); // 기존 파일 내용 그대로
  expect(state.aborted).toBe(1); // 임시 사본 폐기
  await expect(page.locator('.object-list')).toContainText('20×20×50'); // 편집 내용은 화면에 남아 다시 저장 가능
});
