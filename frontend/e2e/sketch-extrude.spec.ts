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

/** 곡면(원기둥) 메시는 다각형 근사 → 바운딩 박스를 허용 오차로 비교 */
async function expectMeshNear(page: Page, id: string, min: number[], max: number[], tol = 0.02) {
  await expect
    .poll(async () => {
      const m = (await sources(page))[id];
      if (!m || m.source !== 'server') return 'not ready';
      const off = [...m.min.map((v, i) => Math.abs(v - min[i]!)), ...m.max.map((v, i) => Math.abs(v - max[i]!))];
      return Math.max(...off) <= tol ? 'ok' : `${m.min} / ${m.max}`;
    }, { timeout: 20_000 })
    .toBe('ok');
}

async function setField(page: Page, testId: string, value: string) {
  const f = page.getByTestId(testId);
  await f.fill(value);
  await f.press('Enter');
}

/** 파일 열기: 편집기에서는 툴바 "열기", "새 프로젝트" 뒤의 시작 화면에서는 "파일 열기" */
async function open(page: Page, file: string) {
  const onHome = await page.getByTestId('home').isVisible();
  const button = onHome ? page.getByTestId('home-open') : page.getByRole('button', { name: '열기' });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser'), button.click()]);
  await chooser.setFiles(file);
  await page.waitForFunction(() => !!window.__AI3D_DEV__); // 시작 화면에서 열면 편집기가 다시 그려진다
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
  expect(saved.formatVersion).toBe(32);
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

test('스케치 관리: 이름 변경, 요소 추가·이동·삭제, 쓰이는 스케치는 삭제 불가', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '+ 사각형 스케치' }).click();

  const name = page.getByLabel('이름');
  await name.fill('뚜껑 윤곽');
  await name.press('Enter');
  await expect(page.locator('[data-sketch-id="sketch_1"]')).toContainText('뚜껑 윤곽');

  await page.getByRole('button', { name: '+ 원', exact: true }).click();
  await expect(page.getByTestId('dim-c1.diameter')).toHaveValue('10');
  await setField(page, 'center-c1-x', '15');
  await expect(page.getByTestId('center-c1-x')).toHaveValue('15');
  expect((await scene(page)).command).toEqual({ type: 'set_entity_center', sketch: 'sketch_1', entity: 'c1', center: [15, 0] });
  await page.getByTestId('delete-entity-c1').click();
  await expect(page.getByTestId('dim-c1.diameter')).toHaveCount(0);

  await page.getByTestId('extrude-r1').click(); // 돌출 객체가 선택됨
  await page.locator('[data-sketch-id="sketch_1"]').click();
  await expect(page.getByTestId('delete-sketch')).toBeDisabled();
  await expect(page.getByTestId('delete-entity-r1')).toBeDisabled();

  // 돌출 객체의 윤곽 중심 이동 → 메시가 따라 이동 (로컬 좌표 메시)
  await page.locator('[data-object-id="extrude_1"]').click();
  await setField(page, 'center-r1-x', '10');
  await expectMesh(page, 'extrude_1', [-20, -20, 0], [40, 20, 4]);

  // 돌출을 지우면 스케치도 지울 수 있다
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await page.locator('[data-sketch-id="sketch_1"]').click();
  await page.getByTestId('delete-sketch').click();
  await expect(page.locator('[data-sketch-id="sketch_1"]')).toHaveCount(0);
  await page.keyboard.press('Control+z'); // 실행 취소로 복구
  await expect(page.locator('[data-sketch-id="sketch_1"]')).toBeVisible();
});

test('뷰포트에서 직접 그리기: 사각형 드래그 → 같은 스케치에 원 → Esc → 돌출', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  const drag = async (a: [number, number], b: [number, number]) => {
    const p = await at(...a);
    const q = await at(...b);
    await page.mouse.move(p.x, p.y);
    await page.mouse.down();
    await page.mouse.move((p.x + q.x) / 2, (p.y + q.y) / 2, { steps: 5 });
    await page.mouse.move(q.x, q.y, { steps: 5 });
  };

  await page.keyboard.press('r');
  await expect(page.getByTestId('viewport-hint')).toContainText('사각형');
  const before = await scene(page);
  await drag([-20, -10], [20, 10]);
  await expect(page.getByTestId('draw-label')).toHaveText('40 × 20 mm');
  expect(await scene(page)).toEqual(before); // 드래그 중에는 원본·이력 그대로
  await page.mouse.up();
  await expect(page.getByTestId('dim-r1.width')).toHaveValue('40'); // 새 스케치가 선택됨
  await expect(page.getByTestId('dim-r1.height')).toHaveValue('20');
  await expect(page.getByTestId('center-r1-x')).toHaveValue('0');

  // 원 도구: 같은 스케치에 추가 (중심 → 반지름 드래그)
  await page.getByRole('button', { name: /^원/ }).click();
  await drag([10, 0], [13, 0]);
  await page.mouse.up();
  await expect(page.getByTestId('dim-c1.diameter')).toHaveValue('6');
  await expect(page.getByTestId('center-c1-x')).toHaveValue('10');
  expect(await page.evaluate(() => window.__AI3D_DEV__!.scene().past)).toBe(before.past + 2); // 도형마다 이력 1건

  // 클릭만(드래그 없음)은 아무것도 만들지 않는다
  const p = await at(-5, 5);
  await page.mouse.click(p.x, p.y);
  expect(await page.evaluate(() => window.__AI3D_DEV__!.scene().past)).toBe(before.past + 2);

  // Esc: 그리기만 끝나고 스케치 선택은 유지
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('viewport-hint')).toContainText('회전');
  await expect(page.getByTestId('sketch-properties')).toBeVisible();
  await page.getByTestId('extrude-r1').click();
  await expectMesh(page, 'extrude_1', [-20, -10, 0], [20, 10, 4]);
});

test('XZ 평면: 평면을 바꾸고 돌출 → 서버 메시가 정면 방향, 그 평면 위에 원을 그린다', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: '+ 사각형 스케치' }).click();
  await page.getByTestId('sketch-plane').selectOption('XZ');
  await setField(page, 'center-r1-y', '20'); // v = Z → 바닥 위로
  await page.getByTestId('extrude-r1').click();
  // 60×40 사각형, 중심 (0, 20) on XZ, 4mm 돌출 → X ±30, Y −4..0, Z 0..40
  await expectMesh(page, 'extrude_1', [-30, -4, 0], [30, 0, 40]);
  await expect(page.getByTestId('print-check')).toHaveText('출력 검사 ✓', { timeout: 20_000 });

  // 스케치를 선택하고 원 도구: XZ 평면(y=0) 위의 점을 드래그
  await page.locator('[data-sketch-id="sketch_1"]').click();
  await page.keyboard.press('c');
  const at = (x: number, z: number) => page.evaluate(([x, z]) => window.__AI3D_DEV__!.project(x!, 0, z!), [x, z]);
  const a = await at(10, 20);
  const b = await at(15, 20);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down();
  await page.mouse.move(b.x, b.y, { steps: 6 });
  await page.mouse.up();
  await expect(page.getByTestId('dim-c1.diameter')).toHaveValue('10');
  await expect(page.getByTestId('center-c1-x')).toHaveValue('10');
  await expect(page.getByTestId('center-c1-y')).toHaveValue('20');
});

test('면 위 스케치: 판 윗면에 기둥 → 판 두께 변경을 따라감 → 안쪽 홈 → 붙은 판 삭제 거부 → 저장·다시 열기', async ({ page }, info) => {
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: '+ 사각형 스케치' }).click();
  await page.getByTestId('extrude-r1').click(); // 판 60×40×4 (extrude_1)

  // 판의 윗면(끝 면)에 스케치 → 원 Ø10 → 6mm 기둥
  await expect(page.getByTestId('face-pick')).toHaveValue('end');
  await page.getByTestId('face-sketch').click();
  await expect(page.getByTestId('sketch-plane')).toContainText('끝 면');
  await page.getByRole('button', { name: '+ 원', exact: true }).click();
  await setField(page, 'extrude-distance-c1', '6');
  await page.getByTestId('extrude-c1').click(); // extrude_2
  await expectMeshNear(page, 'extrude_2', [-5, -5, 4], [5, 5, 10]);

  // 판 두께 4 → 6: 기둥이 따라 올라간다
  await page.locator('[data-object-id="extrude_1"]').click();
  await setField(page, 'param-distance', '6');
  await expectMesh(page, 'extrude_1', [-30, -20, 0], [30, 20, 6]);
  await expectMeshNear(page, 'extrude_2', [-5, -5, 6], [5, 5, 12]);

  // 같은 면 스케치에 사각형 → −2mm (안쪽) 홈
  await page.locator('[data-sketch-id="sketch_2"]').click();
  await page.getByRole('button', { name: '+ 사각형', exact: true }).click(); // r1 20×20
  await setField(page, 'center-r1-x', '20');
  await setField(page, 'extrude-distance-r1', '-2');
  await page.getByTestId('extrude-r1').click(); // extrude_3
  await expectMesh(page, 'extrude_3', [10, -10, 4], [30, 10, 6]);

  // 스케치가 붙은 판은 삭제할 수 없다
  await page.locator('[data-object-id="extrude_1"]').click();
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('면에 붙어 있어 삭제할 수 없습니다');
  await expect(page.locator('[data-object-id="extrude_1"]')).toBeVisible();

  // 저장(v3) → 새 프로젝트 → 다시 열기: 면 참조가 그대로
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const saved = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(32);
  expect(saved.model.sketches[1].plane).toEqual({ type: 'face', object: 'extrude_1', face: 'end', offset: 0 });
  const file = info.outputPath('면 스케치.ai3d');
  writeFileSync(file, JSON.stringify(saved));
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await open(page, file);
  await expectMeshNear(page, 'extrude_2', [-5, -5, 6], [5, 5, 12]);
});

test('구속 해석기: 다각형 그리기 → 고정·수평·수직·길이로 40×20 완전 구속 → 모순 거부 → 돌출 → 길이 50 → 저장·다시 열기', async ({ page }, info) => {
  await page.addInitScript(() => {
    for (const k of ['showSaveFilePicker', 'showOpenFilePicker']) Object.defineProperty(window, k, { value: undefined, configurable: true });
    // 손으로 구속을 넣는 흐름을 검사하므로 자동 구속은 끈다 (자동 구속은 sketch-paper.spec)
    localStorage.setItem('ai3d.sketchView', JSON.stringify({ autoRelations: false }));
  });
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  const at = (x: number, y: number) => page.evaluate(([x, y]) => window.__AI3D_DEV__!.project(x!, y!, 0), [x, y]);
  const click = async (x: number, y: number) => {
    const p = await at(x, y);
    await page.mouse.click(p.x, p.y);
  };

  // 1. 다각형 도구로 대충 그린 사각형 (첫 점을 다시 클릭해 닫기)
  await page.keyboard.press('p');
  await click(0, 0);
  await click(41, 2);
  await click(39, 21);
  await click(-2, 19);
  await expect(page.getByTestId('draw-label')).toContainText('꼭짓점 4개');
  await click(0, 0);
  await page.keyboard.press('Escape'); // 도구만 끝냄 (스케치 선택 유지)
  await expect(page.getByTestId('pt-poly1.p0-x')).toHaveValue('0');
  await expect(page.getByTestId('sketch-dof')).toContainText('자유도 8');

  // 2. 구속: 고정 → 수평·수직 4개 → 길이 2개 = 완전 구속
  await page.getByTestId('fix-poly1.p0').click();
  for (const [kind, e] of [['h', 0], ['v', 1], ['h', 2], ['v', 3]] as const) await page.getByTestId(`${kind}-poly1.e${e}`).click();
  await expect(page.getByTestId('sketch-dof')).toContainText('자유도 2');
  await page.getByTestId('len-poly1.e0').click();
  await setField(page, 'cval-k6', '40');
  await page.getByTestId('len-poly1.e1').click();
  await setField(page, 'cval-k7', '20');
  await expect(page.getByTestId('sketch-dof')).toHaveText('자유도 0 · 완전 구속');
  await expect(page.getByTestId('pt-poly1.p2-x')).toHaveValue('40');
  await expect(page.getByTestId('pt-poly1.p2-y')).toHaveValue('20');

  // 3. 모순(40 ≠ 20 인데 같은 길이) → 거부, 원본 그대로
  await page.getByTestId('pair-type').selectOption('equal');
  await page.getByTestId('pair-a').selectOption('poly1.e0');
  await page.getByTestId('pair-b').selectOption('poly1.e1');
  await page.getByTestId('pair-add').click();
  await expect(page.getByRole('alert')).toContainText('같은 길이 구속을 추가할 수 없습니다');
  await expect(page.getByTestId('constraint-k8')).toHaveCount(0);

  // 4. 돌출 → 서버 메시 40×20×4, 길이 50 으로 바꾸면 다시 계산
  await page.getByTestId('extrude-poly1').click();
  await expectMesh(page, 'extrude_1', [0, 0, 0], [40, 20, 4]);
  await page.locator('[data-sketch-id="sketch_1"]').click();
  await setField(page, 'cval-k6', '50');
  await expectMesh(page, 'extrude_1', [0, 0, 0], [50, 20, 4]);

  // 5. 저장(v4) → 다시 열기: 구속과 풀린 좌표가 그대로
  const [download] = await Promise.all([page.waitForEvent('download'), page.keyboard.press('Control+s')]);
  const saved = JSON.parse(readFileSync((await download.path())!, 'utf8'));
  expect(saved.formatVersion).toBe(32);
  expect(saved.model.sketches[0].constraints).toHaveLength(7);
  expect(saved.model.sketches[0].entities[0].points).toEqual([[0, 0], [50, 0], [50, 20], [0, 20]]);
  const file = info.outputPath('구속 판.ai3d');
  writeFileSync(file, JSON.stringify(saved));
  await page.getByRole('button', { name: '새 프로젝트' }).click();
  await open(page, file);
  await expectMesh(page, 'extrude_1', [0, 0, 0], [50, 20, 4]);
  await page.locator('[data-sketch-id="sketch_1"]').click();
  await expect(page.getByTestId('sketch-dof')).toHaveText('자유도 0 · 완전 구속');
});

test('회전: 축을 넘는 프로파일은 회전 불가 → XZ 평면 사각형을 v 축 둘레 360° → 각도 180° 로 반쪽', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => !!window.__AI3D_DEV__);
  await page.getByRole('button', { name: '삭제', exact: true }).click();
  await page.getByRole('button', { name: '+ 사각형 스케치' }).click();
  await page.getByTestId('sketch-plane').selectOption('XZ');
  await expect(page.getByTestId('revolve-r1')).toBeDisabled(); // u −30..30 → 축(u = 0)을 넘음
  await setField(page, 'center-r1-x', '40'); // u 10..70
  await setField(page, 'center-r1-y', '20'); // v(= Z) 0..40
  await expect(page.getByTestId('revolve-r1')).toBeEnabled();
  await page.getByTestId('revolve-r1').click(); // revolve_1, 360°
  await expectMeshNear(page, 'revolve_1', [-70, -70, 0], [70, 70, 40], 0.1);
  await expect(page.locator('[data-object-id="revolve_1"]')).toContainText('Ø140×40 360°');

  // 각도 180°: +u 가 −w(XZ 평면의 법선 −Y 의 반대 = +Y) 쪽으로 → Y ≥ 0 반쪽
  await setField(page, 'param-angle', '180');
  await expectMeshNear(page, 'revolve_1', [-70, 0, 0], [70, 70, 40], 0.1);
  await expect(page.getByTestId('print-check')).toHaveText('출력 검사 ✓', { timeout: 20_000 });
});
