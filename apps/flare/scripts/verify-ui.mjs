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
async function differentPixels([expected, actual]) {
  const pixels = async (bytes) => {
    const image = await createImageBitmap(new Blob([new Uint8Array(bytes)], { type: "image/png" }));
    const canvas = new OffscreenCanvas(image.width, image.height);
    const context = canvas.getContext("2d");
    context.drawImage(image, 0, 0);
    const data = context.getImageData(0, 0, image.width, image.height).data;
    image.close();
    return { width: canvas.width, height: canvas.height, data };
  };
  const left = await pixels(expected);
  const right = await pixels(actual);
  if (left.width !== right.width || left.height !== right.height) return Infinity;
  let count = 0;
  for (let offset = 0; offset < left.data.length; offset += 4) {
    for (let channel = 0; channel < 4; channel++) {
      if (left.data[offset + channel] !== right.data[offset + channel]) {
        count++;
        break;
      }
    }
  }
  return count;
}
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
    "packages/ui/components/icon/Icon.tsx",
    "packages/ui/components/icon/icon-names.ts",
    "apps/web/public/icons/sprite.svg",
    "packages/ui/components/button/Button.tsx",
    "packages/features/calendars/components/DatePicker.tsx",
    "packages/dayjs",
    "packages/i18n/locales/en/common.json",
    "packages/ui/components/tooltip/Tooltip.tsx",
    "packages/features/calendars/lib/getAvailableDatesInMonth.ts",
    "packages/lib/dayjs",
    "packages/lib/weekday.ts",
    "packages/lib/dateTimeFormatter.ts",
    "packages/ui/components/skeleton/Skeleton.tsx",
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
  optimizeDeps: {
    noDiscovery: true,
    include: [
      "react",
      "react-dom/client",
      "tailwind-merge",
      "class-variance-authority",
      "@radix-ui/react-tooltip",
      "dayjs",
      "zod",
      ...[
        "customParseFormat",
        "duration",
        "isBetween",
        "isToday",
        "localizedFormat",
        "minMax",
        "relativeTime",
        "timezone",
        "toArray",
        "utc",
      ].map((name) => `dayjs/plugin/${name}`),
    ],
  },
  css: { postcss: fileURLToPath(new URL("../", import.meta.url)) },
  resolve: {
    alias: {
      "@reference/title": fileURLToPath(
        new URL("../../web/modules/bookings/components/event-meta/Title.tsx", import.meta.url)
      ),
      "@calcom/ui/classNames": fileURLToPath(new URL("../../../packages/ui/classNames.ts", import.meta.url)),
      "@reference/icon": fileURLToPath(
        new URL("../../../packages/ui/components/icon/Icon.tsx", import.meta.url)
      ),
      "@reference/button": fileURLToPath(
        new URL("../../../packages/ui/components/button/Button.tsx", import.meta.url)
      ),
      "@reference/tooltip": fileURLToPath(
        new URL("../../../packages/ui/components/tooltip/Tooltip.tsx", import.meta.url)
      ),
      "next/link": join(root, "button-boundaries.jsx"),
      "../tooltip/Tooltip": join(root, "button-boundaries.jsx"),
      "@reference/calendar-day": fileURLToPath(
        new URL("../../../packages/features/calendars/components/DatePicker.tsx", import.meta.url)
      ),
      "@calcom/dayjs": fileURLToPath(new URL("../../../packages/dayjs/index.ts", import.meta.url)),
      ...Object.fromEntries(
        [
          "zustand/shallow",
          "@calcom/embed-core/embed-iframe",
          "@calcom/features/bookings/Booker/BookerStoreProvider",
          "@calcom/lib/hooks/useLocale",
          "./NoAvailabilityDialog",
        ].map((name) => [name, join(root, "calendar-boundaries.jsx")])
      ),
      "@calcom/features/calendars/lib/getAvailableDatesInMonth": fileURLToPath(
        new URL("../../../packages/features/calendars/lib/getAvailableDatesInMonth.ts", import.meta.url)
      ),
      "@calcom/lib/dayjs": fileURLToPath(new URL("../../../packages/lib/dayjs/index.ts", import.meta.url)),
      "@calcom/lib/weekday": fileURLToPath(new URL("../../../packages/lib/weekday.ts", import.meta.url)),
      "@calcom/ui/components/button": fileURLToPath(
        new URL("../../../packages/ui/components/button/Button.tsx", import.meta.url)
      ),
      "@calcom/ui/components/skeleton": fileURLToPath(
        new URL("../../../packages/ui/components/skeleton/Skeleton.tsx", import.meta.url)
      ),
      "@calcom/ui/components/tooltip": fileURLToPath(
        new URL("../../../packages/ui/components/tooltip/Tooltip.tsx", import.meta.url)
      ),
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
  const sessionContext = await browser.newContext();
  const sessionPage = await sessionContext.newPage();
  await sessionPage.goto(origin);
  const attemptsModule = `/@fs${fileURLToPath(new URL("../src/client/create-attempt.ts", import.meta.url))}`;
  const firstAttempt = await sessionPage.evaluate(async (url) => {
    const { CreateAttempts } = await import(url);
    return new CreateAttempts({ storage: sessionStorage, scope: "/intro" }).begin({
      start: Date.UTC(2030, 0, 1, 10),
      name: "Browser guest",
      email: "browser@example.test",
      timeZone: "UTC",
    });
  }, attemptsModule);
  await sessionPage.reload();
  const resumed = await sessionPage.evaluate(async (url) => {
    const { CreateAttempts } = await import(url);
    return new CreateAttempts({ storage: sessionStorage, scope: "/intro" }).read();
  }, attemptsModule);
  assert.deepEqual(resumed, firstAttempt);
  const requestKey = firstAttempt.request.requestKey;
  await sessionPage.evaluate(
    async ({ url, requestKey }) => {
      const { CreateAttempts } = await import(url);
      new CreateAttempts({ storage: sessionStorage, scope: "/intro" }).acknowledge(requestKey, {
        id: "a".repeat(64),
        token: "b".repeat(43),
      });
    },
    { url: attemptsModule, requestKey }
  );
  await sessionPage.reload();
  const receipt = await sessionPage.evaluate(async (url) => {
    const { CreateAttempts } = await import(url);
    return {
      saved: new CreateAttempts({ storage: sessionStorage, scope: "/intro" }).read(),
      attendeeRetained: ["browser@example.test", "Browser guest"].some((value) =>
        JSON.stringify({ ...sessionStorage }).includes(value)
      ),
    };
  }, attemptsModule);
  assert.deepEqual(receipt.saved, {
    kind: "receipt",
    requestKey,
    access: { id: "a".repeat(64), token: "b".repeat(43) },
  });
  assert.equal(receipt.attendeeRetained, false);
  await sessionContext.close();
  console.log(
    "PASS native session storage preserves the request across reload and replaces attendee data with a receipt."
  );
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
      const reference = await page.screenshot({
        path: fileURLToPath(new URL(`reference-title-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      await page.goto(`${origin}/candidate.html?theme=${theme}`);
      await page.locator('[data-testid="event-title"]').nth(2).waitFor();
      await page.evaluate(() => document.fonts.ready);
      assert.equal(await page.locator("h1").count(), 2);
      assert.equal(await page.locator("h2").count(), 1);
      const candidate = await page.screenshot({
        path: fileURLToPath(new URL(`candidate-title-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      const difference = await page.evaluate(differentPixels, [[...reference], [...candidate]]);
      assert.equal(difference, 0, `${name} ${theme} must match the pinned reference`);
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log(
    "PASS EventTitle matches the pinned reference with zero different pixels at desktop/mobile widths in light/dark themes."
  );
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.name));
      await page.goto(`${origin}/icons.html?theme=${theme}`);
      await page.getByTestId("svg-props").waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("main svg")].every((icon) => icon.getBBox().width > 0)
      );
      const count = await page.getByTestId("sprite-icon").count();
      assert.ok(count > 0);
      const reference = await page.screenshot({
        path: fileURLToPath(new URL(`reference-icons-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      await page.goto(`${origin}/candidate-icons.html?theme=${theme}`);
      await page.getByTestId("svg-props").waitFor();
      await page.waitForFunction(() =>
        [...document.querySelectorAll("main svg")].every((icon) => icon.getBBox().width > 0)
      );
      assert.equal(await page.getByTestId("sprite-icon").count(), count);
      assert.equal(await page.locator('main svg:not([aria-hidden="true"])').count(), 0);
      assert.equal(await page.getByTestId("number-size").getAttribute("width"), "24");
      assert.equal(await page.getByTestId("string-size").getAttribute("width"), "2rem");
      assert.equal(await page.getByTestId("svg-props").getAttribute("width"), "40");
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const candidate = await page.screenshot({
        path: fileURLToPath(new URL(`candidate-icons-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(differentPixels, [[...reference], [...candidate]]),
        0,
        `${name} ${theme} icons must match the pinned reference`
      );
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log(
    "PASS all sprite icons match the pinned reference with zero different pixels at desktop/mobile widths in light/dark themes."
  );
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      await page.goto(`${origin}/buttons.html?theme=${theme}`);
      await page.getByTestId("interactive").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() =>
        [...document.querySelectorAll("main svg use")].every((use) => use.parentNode.getBBox().width > 0)
      );
      await page.addStyleTag({
        content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
      });
      const reference = await page.screenshot({
        path: fileURLToPath(new URL(`reference-buttons-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      await page.goto(`${origin}/buttons.html?candidate&theme=${theme}`);
      await page.getByTestId("interactive").waitFor();
      await page.evaluate(() => document.fonts.ready);
      await page.waitForFunction(() =>
        [...document.querySelectorAll("main svg use")].every((use) => use.parentNode.getBBox().width > 0)
      );
      await page.addStyleTag({
        content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
      });
      const candidate = await page.screenshot({
        path: fileURLToPath(new URL(`candidate-buttons-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(differentPixels, [[...reference], [...candidate]]),
        0,
        `${name} ${theme} buttons must match the pinned reference`
      );
      assert.equal(await page.getByTestId("loading").count(), 4);
      assert.equal(await page.locator('[data-testid="loading"]:disabled').count(), 4);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByTestId("interactive").click();
      assert.equal(await page.getByLabel("Actions").textContent(), "1");
      await page.getByTestId("interactive").press("Enter");
      assert.equal(await page.getByLabel("Actions").textContent(), "2");
      await page.getByTestId("submit").click();
      assert.equal(await page.getByLabel("Actions").textContent(), "3");
      await page.getByTestId("disabled").evaluate((button) => button.click());
      assert.equal(await page.getByLabel("Actions").textContent(), "3");
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log(
    "PASS native booking buttons match the pinned reference with zero different pixels and retain keyboard, form, disabled, loading and ref behavior."
  );
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "UTC" });
      const page = await context.newPage();
      const errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("console", (message) => {
        if (message.type() === "error") errors.push(message.text());
      });
      await page.clock.setFixedTime(new Date("2030-01-09T12:00:00Z"));
      await page.goto(`${origin}/calendar-days.html?theme=${theme}`);
      await page.getByRole("button", { name: "Date 11", exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const reference = await page.screenshot({
        path: fileURLToPath(new URL(`reference-calendar-days-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      assert.deepEqual(errors, []);
      await page.goto(`${origin}/calendar-days.html?candidate&theme=${theme}`);
      await page.getByRole("button", { name: "Date 11", exact: true }).waitFor();
      await page.evaluate(() => document.fonts.ready);
      const candidate = await page.screenshot({
        path: fileURLToPath(new URL(`candidate-calendar-days-${name}-${theme}.png`, artifacts)),
        fullPage: true,
      });
      assert.equal(
        await page.evaluate(differentPixels, [[...reference], [...candidate]]),
        0,
        `${name} ${theme} calendar days must match the pinned reference`
      );
      assert.equal(await page.getByTestId("day").count(), 12);
      assert.equal(await page.locator('button[data-disabled="true"]').count(), 4);
      assert.equal(await page.getByTestId("away-emoji").count(), 2);
      assert.equal(await page.locator(".sr-only").filter({ hasText: "Today" }).count(), 3);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.getByRole("button", { name: "Date 0", exact: true }).click();
      assert.equal(await page.getByLabel("Selections").textContent(), "1");
      await page.getByRole("button", { name: "Date 1", exact: true }).press("Enter");
      assert.equal(await page.getByLabel("Selections").textContent(), "2");
      await page.getByRole("button", { name: "Date 2", exact: true }).evaluate((button) => button.click());
      assert.equal(await page.getByLabel("Selections").textContent(), "2");
      assert.deepEqual(errors, []);
      await context.close();
    }
  }
  console.log(
    "PASS calendar day states match the pinned reference with zero different pixels and preserve native selection and disabled behavior."
  );
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      for (const side of ["top", "right", "bottom", "left"]) {
        const context = await browser.newContext({ viewport });
        const page = await context.newPage();
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        await page.goto(`${origin}/tooltips.html?theme=${theme}&side=${side}`);
        await page.getByTestId("tooltip-content").waitFor();
        await page.evaluate(() => document.fonts.ready);
        const reference = await page.screenshot({
          path: fileURLToPath(new URL(`reference-tooltip-${name}-${theme}-${side}.png`, artifacts)),
          fullPage: true,
        });
        assert.deepEqual(errors, []);
        await page.goto(`${origin}/tooltips.html?candidate&theme=${theme}&side=${side}`);
        await page.getByTestId("tooltip-content").waitFor();
        await page.evaluate(() => document.fonts.ready);
        const candidate = await page.screenshot({
          path: fileURLToPath(new URL(`candidate-tooltip-${name}-${theme}-${side}.png`, artifacts)),
          fullPage: true,
        });
        assert.equal(
          await page.evaluate(differentPixels, [[...reference], [...candidate]]),
          0,
          `${name} ${theme} ${side} tooltip must match the pinned reference`
        );
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
        if (side === "top") {
          await page.goto(`${origin}/tooltips.html?candidate&theme=${theme}&mode=interactive`);
          const trigger = page.getByRole("button", { name: "View next month" });
          const tooltip = page.getByRole("tooltip");
          await trigger.hover();
          await tooltip.waitFor();
          assert.equal(await tooltip.textContent(), "February");
          assert.equal(await page.getByTestId("tooltip-content").getAttribute("data-side"), "top");
          assert.equal(await trigger.getAttribute("aria-describedby"), await tooltip.getAttribute("id"));
          await page.keyboard.press("Escape");
          await tooltip.waitFor({ state: "hidden" });
          await page.mouse.move(0, 0);
          await page.keyboard.press("Tab");
          await tooltip.waitFor();
          await trigger.evaluate((button) => button.blur());
          await tooltip.waitFor({ state: "hidden" });
          await page.goto(`${origin}/tooltips.html?candidate&theme=${theme}&mode=closed`);
          await page.getByRole("button", { name: "View next month" }).focus();
          await assert.rejects(
            () => page.getByRole("tooltip").waitFor({ timeout: 200 }),
            (error) => error instanceof Error && error.name === "TimeoutError"
          );
          await page.goto(`${origin}/tooltips.html?candidate&theme=${theme}&mode=empty`);
          await page.getByTestId("empty-child").nth(2).waitFor();
          assert.equal(await page.locator("main [data-state]").count(), 0);
          assert.equal(await page.getByRole("tooltip").count(), 0);
        }
        assert.deepEqual(errors, []);
        await context.close();
      }
    }
  }
  console.log(
    "PASS tooltips match the pinned wrapper with zero different pixels on all four sides and preserve keyboard, hover, controlled and empty-content behavior."
  );
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      for (const [scenario, expected] of [
        ["offset", "none"],
        ["early", "2030-01-10"],
        ["selected", "2030-01-12"],
        ["late", "2030-01-21"],
        ["compact", "2030-01-21"],
        ["loading", "none"],
        ["empty", "none"],
        ["monday", "2030-01-10"],
        ["leap", "2032-02-29"],
        ["ooo", "2030-01-11"],
        ["minimum", "2030-01-12"],
      ]) {
        const captures = [];
        for (const version of ["reference", "candidate"]) {
          const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "UTC" });
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          let date = "2030-01-09T12:00:00Z";
          if (["late", "compact"].includes(scenario)) date = "2030-01-20T12:00:00Z";
          if (scenario === "leap") date = "2032-01-09T12:00:00Z";
          await page.clock.setFixedTime(new Date(date));
          const entry = version === "reference" ? "months.html" : "candidate-months.html";
          await page.goto(`${origin}/${entry}?case=${scenario}&theme=${theme}`);
          await page.getByTestId("selected-month-label").waitFor();
          await page.addStyleTag({
            content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
          });
          assert.equal(await page.locator("main svg").count(), 2);
          await page.waitForFunction(() =>
            [...document.querySelectorAll("main svg")].every((icon) => icon.getBBox().width > 0)
          );
          await page.waitForFunction(
            (value) => document.querySelector('[data-testid="selection"]').textContent === value,
            expected
          );
          if (scenario === "offset") {
            assert.equal(await page.getByTestId("selected-month-label").getAttribute("datetime"), "2030-03");
            assert.equal(await page.getByRole("button", { name: "1", exact: true }).isDisabled(), true);
          }
          assert.equal(await page.locator("button.bg-brand-default").count(), expected === "none" ? 0 : 1);
          await page.evaluate(() => document.fonts.ready);
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          captures.push(
            Array.from(
              await page.screenshot({
                path: fileURLToPath(new URL(`${version}-month-${name}-${theme}-${scenario}.png`, artifacts)),
                fullPage: true,
              })
            )
          );
          if (version === "candidate")
            assert.equal(
              await page.evaluate(differentPixels, captures),
              0,
              `month ${name}/${theme}/${scenario} pixels`
            );
          if (scenario === "early") {
            await page.getByRole("button", { name: "12", exact: true }).click();
            assert.equal(await page.getByTestId("selection").textContent(), "2030-01-12");
            await page.getByTestId("incrementMonth").click();
            await page.waitForFunction(
              () => document.querySelector('[data-testid="selection"]').textContent === "2030-02-01"
            );
            await page.getByTestId("decrementMonth").click();
            await page.waitForFunction(
              () => document.querySelector('[data-testid="selection"]').textContent === "2030-01-10"
            );
            assert.equal(await page.getByTestId("decrementMonth").isDisabled(), true);
          }
          if (scenario === "late") {
            assert.equal(await page.getByTestId("day").first().textContent(), "8");
            await page.getByRole("button", { name: "1", exact: true }).hover();
            await page.getByRole("tooltip").waitFor();
            assert.equal(await page.getByRole("tooltip").textContent(), "February");
          }
          assert.deepEqual(errors, []);
          await context.close();
        }
      }
    }
  }
  console.log(
    "PASS month picker matches the pinned source with zero different pixels in eleven scenarios across desktop/mobile and light/dark, preserving offset-date boundaries, selection, navigation and next-month tooltip."
  );
} finally {
  try {
    await browser?.close();
  } finally {
    await server.close();
  }
}
