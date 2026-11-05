import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { expect, test } from "@playwright/test";

const root = path.resolve(import.meta.dirname, "..");
const routes = readFileSync(path.join(root, "../../docs/porting/inventory/routes.tsv"), "utf8")
  .split("\n")
  .filter((line) => line.startsWith("apps/docs/content/"))
  .map((line) => {
    const [file, , , route] = line.split("\t");
    const source = readFileSync(path.join(root, "../..", file), "utf8");
    const prose = source.replace(/^(?:> )?```[^\n]*\n[\s\S]*?^(?:> )?```/gm, "");
    const heading = prose.match(/^# (.+)$/m)?.[1];
    const title = source.match(/^title: "(.+)"$/m)?.[1] ?? heading;
    return { route, source, heading, title };
  });

test.beforeEach(async ({ page, baseURL }) => {
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (request.resourceType() !== "image" || new URL(request.url()).origin === baseURL) {
      await route.continue();
      return;
    }
    await route.fulfill({
      contentType: "image/svg+xml",
      body: '<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>',
    });
  });
});

test("every content route hydrates with original metadata, code blocks and anchors", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  page.on("console", (message) => {
    if (message.type() === "error" && !message.text().includes("404")) errors.push(message.text());
  });
  for (const { route, source, title, heading } of routes) {
    await test.step(route, async () => {
      const response = await page.goto(route);
      expect(response?.status()).toBe(200);
      expect(response?.headers()["x-vinext-cache"]).toBe("HIT");
      await expect(page).toHaveTitle(title ?? "");
      await expect(page.locator("main")).toBeVisible();
      if (heading) await expect(page.locator("main h1")).toHaveText(heading);
      const codeBlocks = [...source.replace(/^> ?/gm, "").matchAll(/^```[^\n]*\n([\s\S]*?)^```/gm)].map(
        (match) => match[1].trim()
      );
      expect(
        (await page.locator("main pre code").allTextContents()).map((text) =>
          text.replace(/^[ \t]+$/gm, "").trim()
        )
      ).toEqual(codeBlocks);
      const missingAnchors = await page
        .locator('a[href^="#"]')
        .evaluateAll((links) =>
          links
            .map((link) => link.getAttribute("href")?.slice(1))
            .filter((id) => id && !document.getElementById(decodeURIComponent(id)))
        );
      expect(missingAnchors).toEqual([]);
      const images = [...source.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)].map((match) => match[1]);
      const renderedImages = await page
        .locator("main img")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("src")));
      for (const image of images) expect(renderedImages).toContain(image);

      expect(errors).toEqual([]);
    });
  }
});

test("public assets and all six preloaded fonts retain source bytes", async ({ request }) => {
  for (const file of readdirSync(path.join(root, "public")).filter((file) => file.endsWith(".svg"))) {
    const response = await request.get(`/${file}`);
    expect(response.status()).toBe(200);
    expect(await response.body()).toEqual(readFileSync(path.join(root, "public", file)));
  }
  const html = await (await request.get("/")).text();
  const fonts = [...html.matchAll(/href="([^"]+\.woff2)"/g)].map((match) => match[1]);
  expect(new Set(fonts).size).toBe(6);
  for (const url of new Set(fonts)) {
    const file = readdirSync(path.join(root, "fonts")).find((name) =>
      path.basename(url).startsWith(name.replace(".woff2", "."))
    );
    expect(file).toBeTruthy();
    expect(await (await request.get(url)).body()).toEqual(readFileSync(path.join(root, "fonts", file ?? "")));
  }
});

test("navigation, history, theme and final HTML search work together", async ({ page, context }) => {
  await context.grantPermissions(["clipboard-read", "clipboard-write"]);
  await page.goto("/");
  await expect(page.locator("main")).toContainText("Use at your own risk.");
  await expect(page.locator("main")).toContainText(
    "For any commercial and enterprise-ready scheduling infrastructure"
  );
  await page.locator('main a[href="/installation"]').first().click();
  await expect(page).toHaveURL(/\/installation$/);
  await expect(page.locator("main h1")).toHaveText("Installation");
  await page.goBack();
  await expect(page.locator("main h1")).toHaveText("Cal.diy Self-Hosting Documentation");
  await page.goForward();
  await expect(page.locator("main h1")).toHaveText("Installation");
  await page.getByRole("button", { name: "Copy page", exact: true }).click();
  await expect
    .poll(() => page.evaluate(() => navigator.clipboard.readText()))
    .toBe(readFileSync(path.join(root, "content/installation.mdx"), "utf8").trim());
  await page.locator('a[href="#requirements"]').first().click();
  await expect(page).toHaveURL(/#requirements$/);
  await page.screenshot({ path: "../../test-results/docs/installation.png", fullPage: true });
  await page.locator('[title="Change theme"]:visible').click();
  await page.getByRole("option", { name: "Dark", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.reload();
  await expect(page.locator("html")).toHaveClass(/dark/);
  await page.locator('[title="Change theme"]:visible').click();
  await page.getByRole("option", { name: "Light", exact: true }).click();
  await expect(page.locator("html")).toHaveClass(/light/);
  const search = page.getByRole("combobox");
  await search.fill("Google");
  await expect(page.getByRole("option").first()).toBeVisible();
  await expect(page.getByRole("option").filter({ hasText: "Google" }).first()).toBeVisible();
  await search.fill("zzzzunfindabledocszzzz");
  await expect(page.getByText("No results found.")).toBeVisible();
  await search.fill("Google");
  await page.locator('a[role="option"][href^="/apps/google"]').first().click();
  await expect(page).toHaveURL(/\/apps\/google(?:#.*)?$/);
  await expect(page.locator("main h1")).toHaveText("Google");
});

test("unknown paths, source aliases and private cache files remain unavailable", async ({ request }) => {
  for (const route of [
    "/missing-doc",
    "/index",
    "/apps",
    "/installation.mdx",
    "/_vinext/static-cache/index.json",
    "/missing.svg",
  ]) {
    expect((await request.get(route)).status(), route).toBe(404);
  }
  const redirect = await request.get("/installation/", { maxRedirects: 0 });
  expect(redirect.status()).toBe(308);
  expect(redirect.headers().location).toBe("/installation");
});

test("mobile menu retains nested navigation and readable content", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await page.getByRole("button", { name: "Menu", exact: true }).click();
  await page.locator('a[href="/apps/google"]:visible').first().click();
  await expect(page.locator("main h1")).toHaveText("Google");
  await expect(page.getByRole("button", { name: "Menu", exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: "../../test-results/docs/mobile.png", fullPage: true });
});
