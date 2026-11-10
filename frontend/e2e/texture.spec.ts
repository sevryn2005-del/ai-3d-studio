/**
 * 텍스처 이미지 (형식 v30): 파일 고르기 → 화면에 박스 투영 → GLB 에 이미지·UV (두 엔진) → 한 장 크기 → 지우기,
 * 모델링 모드: 저장 파일에 텍스처, PNG·JPEG 가 아니면 거부.
 */
import { readFileSync } from "node:fs";
import { expect, test, type Page } from "@playwright/test";

const PNG_B64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC";
const png = {
  name: "wood.png",
  mimeType: "image/png",
  buffer: Buffer.from(PNG_B64, "base64"),
};
const sources = (page: Page) =>
  page.evaluate(() => window.__AI3D_DEV__!.meshSources());

function glbJson(b: Buffer) {
  const len = b.readUInt32LE(12);
  return JSON.parse(b.subarray(20, 20 + len).toString("utf8"));
}

for (const engine of ["server", "browser"] as const) {
  test(`텍스처 넣기 → 화면·GLB → 크기 → 지우기 (${engine === "server" ? "CadQuery 서버" : "브라우저"} 엔진)`, async ({
    page,
  }) => {
    test.setTimeout(90_000);
    if (engine === "browser")
      await page.route(
        (url) => url.pathname.startsWith("/api/"),
        (r) => r.abort("connectionrefused"),
      );
    await page.goto("/");
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await expect
      .poll(async () => (await sources(page)).box_1?.source, {
        timeout: 20_000,
      })
      .toBe(engine);
    await page.locator('[data-object-id="box_1"]').click();
    await page.getByTestId("texture-file").setInputFiles(png);
    await expect(page.getByTestId("texture-thumb")).toBeVisible();
    await expect(page.getByTestId("texture-tile")).toHaveValue("50");
    await expect
      .poll(async () => (await sources(page)).box_1?.textured)
      .toBe(true);

    const button = page.getByRole("button", { name: "내보내기 ▾" });
    await button.click();
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("menuitem", { name: /^GLB/ }).click(),
    ]);
    const gltf = glbJson(readFileSync((await dl.path())!));
    expect(gltf.images).toHaveLength(1);
    expect(gltf.images[0].mimeType).toBe("image/png");
    expect(gltf.materials[0].pbrMetallicRoughness.baseColorTexture).toEqual({
      index: 0,
    });

    await page.getByTestId("texture-tile").fill("20");
    await page.getByTestId("texture-tile").press("Enter");
    await expect
      .poll(() => page.evaluate(() => window.__AI3D_DEV__!.scene().command))
      .toMatchObject({ type: "set_appearance", texture: { tile: 20 } });
    await page.getByTestId("texture-remove").click();
    await expect(page.getByTestId("texture-thumb")).toHaveCount(0);
    await expect
      .poll(async () => (await sources(page)).box_1?.textured)
      .toBe(false);
    await page.keyboard.press("Control+z");
    await expect(page.getByTestId("texture-tile")).toHaveValue("20");
  });
}

test.describe("모델링 모드", () => {
  test.use({ storageState: { cookies: [], origins: [] } });
  test("모델링 모드: 텍스처가 저장 파일에 들어가고, 이미지가 아니면 거부", async ({
    page,
  }) => {
    await page.addInitScript(() => {
      for (const k of ["showSaveFilePicker", "showOpenFilePicker"])
        Object.defineProperty(window, k, {
          value: undefined,
          configurable: true,
        });
    });
    await page.goto("/");
    await page.getByTestId("home-modeling").click();
    await page.waitForFunction(() => !!window.__AI3D_DEV__);
    await page.getByTestId("guide-add-uv_sphere").click();
    await page
      .getByTestId("texture-file")
      .setInputFiles({
        name: "note.txt",
        mimeType: "text/plain",
        buffer: Buffer.from("hi"),
      });
    await expect(page.getByTestId("texture-error")).toContainText(
      "PNG 또는 JPEG",
    );
    await page.getByTestId("texture-file").setInputFiles(png);
    await expect(page.getByTestId("texture-error")).toHaveCount(0);
    await expect(page.getByTestId("texture-thumb")).toBeVisible();
    const [dl] = await Promise.all([
      page.waitForEvent("download"),
      page.getByRole("button", { name: "저장", exact: true }).click(),
    ]);
    const saved = JSON.parse(readFileSync((await dl.path())!, "utf8"));
    expect(saved.formatVersion).toBe(42);
    expect(saved.model.objects[0].texture).toEqual({
      image: `data:image/png;base64,${PNG_B64}`,
      tile: 50,
    });
  });
});
