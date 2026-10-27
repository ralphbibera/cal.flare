import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const { createServer } = await import(
  pathToFileURL(createRequire(require.resolve("astro")).resolve("vite")).href
);
const { default: react } = await import(
  pathToFileURL(createRequire(require.resolve("@astrojs/react")).resolve("@vitejs/plugin-react")).href
);
const root = fileURLToPath(new URL("fixtures/title/", import.meta.url));
const artifacts = new URL("../.verification/", import.meta.url);
await promisify(execFile)(
  "git",
  [
    "diff",
    "--quiet",
    "0f19cc46ef6b6426ee398c670575b3c96be7af9e",
    "--",
    "apps/web/modules/bookings/components/event-meta/Title.tsx",
    "packages/ui/classNames.ts",
    "apps/web/styles",
    "packages/config/theme",
    "packages/coss-ui/src/styles/globals.css",
    "apps/web/public/fonts/Inter-roman.var.woff2",
  ],
  { cwd: fileURLToPath(new URL("../../../", import.meta.url)) }
);
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  root,
  configFile: false,
  // Compile unchanged upstream components without activating their Next.js workspace.
  tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
  plugins: [react()],
  css: { postcss: fileURLToPath(new URL("../", import.meta.url)) },
  resolve: {
    alias: {
      "@reference/title": fileURLToPath(
        new URL("../../web/modules/bookings/components/event-meta/Title.tsx", import.meta.url)
      ),
      "@calcom/ui/classNames": fileURLToPath(new URL("../../../packages/ui/classNames.ts", import.meta.url)),
    },
  },
  server: {
    host: "127.0.0.1",
    port: 0,
    fs: {
      deny: ["**/.dev.vars", "**/.dev.vars.*", "**/.env", "**/.env.*", "**/*.{crt,pem,key}", "**/.git/**"],
    },
  },
  logLevel: "error",
});
let browser;
try {
  await server.listen();
  const address = server.httpServer.address();
  assert.ok(address && typeof address !== "string");
  const origin = `http://127.0.0.1:${address.port}`;
  const privateDirectory = await mkdtemp(new URL("private-", artifacts));
  try {
    for (const filename of [".dev.vars", "fixture.key"]) {
      const path = join(privateDirectory, filename);
      await writeFile(path, "fixture-private-value", { mode: 0o600 });
      const response = await fetch(`${origin}/@fs${path}`);
      assert.equal(response.status, 403, `${filename} must remain private`);
      assert.ok(!(await response.text()).includes("fixture-private-value"));
    }
  } finally {
    await rm(privateDirectory, { recursive: true, force: true });
  }
  browser = await chromium.launch();
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "UTC" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.name));
      await page.goto(`${origin}/?theme=${theme}`);
      await page.locator('[data-testid="event-title"]').nth(2).waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.ok(
        await page.evaluate(() =>
          [...document.fonts].some((font) => font.family === "Inter" && font.status === "loaded")
        )
      );
      assert.equal(await page.locator('[data-testid="event-title"]').count(), 3);
      assert.equal(await page.locator("h2").count(), 1);
      assert.equal(
        await page.locator("body").evaluate((node) => getComputedStyle(node).backgroundColor),
        theme === "dark" ? "rgb(15, 15, 15)" : "rgb(238, 239, 242)"
      );
      assert.equal(
        await page
          .locator("h1")
          .first()
          .evaluate((node) => getComputedStyle(node).fontSize),
        "20px"
      );
      assert.equal(await page.locator("h2").evaluate((node) => getComputedStyle(node).fontSize), "24px");
      assert.equal(
        await page
          .locator("h1")
          .first()
          .evaluate((node) => getComputedStyle(node).fontWeight),
        "600"
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      await page.screenshot({
        path: fileURLToPath(new URL(`reference-title-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      await context.close();
    }
  }
  console.log(
    "PASS upstream event-title reference at desktop/mobile widths in light/dark themes. No port parity claimed."
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
