import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { chromium } from "@playwright/test";
import { verifyCalendar } from "./verify-calendar.mjs";
import { verifyPublic } from "./verify-public.mjs";

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
    "packages/ui/components/form/inputs/TextField.tsx",
    "packages/ui/components/form/inputs/Input.tsx",
    "packages/ui/components/form/inputs/types.d.ts",
    "packages/ui/components/form/inputs/Label.tsx",
    "packages/features/calendars/components/DatePicker.tsx",
    "packages/dayjs",
    "packages/ui/components/tooltip/Tooltip.tsx",
    "packages/features/calendars/lib/getAvailableDatesInMonth.ts",
    "packages/lib/dayjs",
    "packages/lib/weekday.ts",
    "packages/lib/dateTimeFormatter.ts",
    "packages/ui/components/skeleton/Skeleton.tsx",
    "apps/web/modules/bookings/components/AvailableTimes.tsx",
    "packages/lib/webstorage.ts",
  ],
  { cwd: fileURLToPath(new URL("../../../", import.meta.url)) }
);
const { stdout: referenceDictionary } = await promisify(execFile)(
  "git",
  ["show", "0f19cc46ef6b6426ee398c670575b3c96be7af9e:packages/i18n/locales/en/common.json"],
  { cwd: fileURLToPath(new URL("../../../", import.meta.url)) }
);
await mkdir(artifacts, { recursive: true });
const server = await createServer({
  root,
  configFile: false,
  // Compile unchanged upstream components without activating their Next.js workspace.
  tsconfig: fileURLToPath(new URL("../tsconfig.json", import.meta.url)),
  plugins: [
    react(),
    {
      name: "pinned-reference-dictionary",
      resolveId(id) {
        if (id.endsWith("/packages/i18n/locales/en/common.json")) return "\0pinned-reference-dictionary";
      },
      load(id) {
        if (id === "\0pinned-reference-dictionary") return `export default ${referenceDictionary}`;
      },
    },
  ],
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
      "framer-motion",
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
      "@reference/times": fileURLToPath(
        new URL("../../web/modules/bookings/components/AvailableTimes.tsx", import.meta.url)
      ),
      "@calcom/lib/webstorage": fileURLToPath(
        new URL("../../../packages/lib/webstorage.ts", import.meta.url)
      ),
      ...Object.fromEntries(
        [
          "@calcom/app-store/_utils/payments/getPaymentAppData",
          "@calcom/atoms/hooks/useIsPlatform",
          "@calcom/features/bookings/Booker/hooks/useBookerTime",
          "@calcom/features/bookings/Booker/utils/query-param",
          "@calcom/features/bookings/lib/useCheckOverlapWithOverlay",
          "@coss/ui/icons",
          "@radix-ui/react-hover-card",
          "./OutOfOfficeInSlots",
          "./SeatsAvailabilityText",
        ].map((name) => [name, join(root, "time-boundaries.jsx")])
      ),
      "@calcom/ui/classNames": fileURLToPath(new URL("../../../packages/ui/classNames.ts", import.meta.url)),
      "@reference/icon": fileURLToPath(
        new URL("../../../packages/ui/components/icon/Icon.tsx", import.meta.url)
      ),
      "@reference/button": fileURLToPath(
        new URL("../../../packages/ui/components/button/Button.tsx", import.meta.url)
      ),
      "@reference/input": fileURLToPath(
        new URL("../../../packages/ui/components/form/inputs/TextField.tsx", import.meta.url)
      ),
      "@reference/textarea": fileURLToPath(
        new URL("../../../packages/ui/components/form/inputs/Input.tsx", import.meta.url)
      ),
      "@reference/label": fileURLToPath(
        new URL("../../../packages/ui/components/form/inputs/Label.tsx", import.meta.url)
      ),
      "../../icon": join(root, "input-boundaries.jsx"),
      "./HintOrErrors": join(root, "input-boundaries.jsx"),
      "react-hook-form": join(root, "input-boundaries.jsx"),
      "../../alert": join(root, "input-boundaries.jsx"),
      "../../tooltip": join(root, "input-boundaries.jsx"),
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
    proxy: { "/api": { target: "http://127.0.0.1:8796" } },
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
  await verifyCalendar(browser, origin);
  await verifyPublic(browser);
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      const captures = { rest: [], focus: [], hover: [], multiline: [] };
      for (const version of ["reference", "candidate"]) {
        const context = await browser.newContext({ viewport, locale: "en-US" });
        try {
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          await page.goto(
            `${origin}/inputs.html?theme=${theme}${version === "candidate" ? "&candidate" : ""}`
          );
          const field = (label) => page.getByLabel(label, { exact: true });
          await field("Name").waitFor();
          await page.evaluate(() => document.fonts.ready);
          await page.addStyleTag({
            content:
              "*, *::before, *::after { animation: none !important; transition: none !important; caret-color: transparent !important; }",
          });
          assert.equal(await page.locator("main input").count(), 8);
          assert.equal(await page.locator("main textarea").count(), 4);
          assert.equal(await field("Notes").evaluate((node) => node.getBoundingClientRect().height), 80);
          assert.equal(
            await field("Custom label").evaluate((node) => node.getBoundingClientRect().height),
            96
          );
          assert.deepEqual(
            await page
              .locator('label[for="custom-notes"]')
              .evaluate((node) => [
                getComputedStyle(node).fontSize,
                getComputedStyle(node).fontWeight,
                getComputedStyle(node).marginBottom,
              ]),
            ["18px", "400", "0px"]
          );
          assert.equal(await field("Small").evaluate((node) => node.getBoundingClientRect().height), 28);
          assert.equal(await field("Name").evaluate((node) => node.getBoundingClientRect().height), 32);
          assert.deepEqual(
            await field("Override").evaluate((node) => [
              node.getBoundingClientRect().width,
              node.getBoundingClientRect().height,
              getComputedStyle(node).borderRadius,
            ]),
            [160, 40, "0px"]
          );
          assert.ok(!(await field("Narrow").getAttribute("class")).split(" ").includes("w-full"));
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          for (const state of ["rest", "focus", "hover", "multiline"]) {
            if (state === "focus") await field("Name").focus();
            if (state === "hover") {
              await field("Name").blur();
              await field("Small").hover();
            }
            if (state === "multiline") await field("Notes").focus();
            captures[state].push([
              ...(await page.screenshot({
                path: fileURLToPath(new URL(`${version}-input-${name}-${theme}-${state}.png`, artifacts)),
                fullPage: true,
              })),
            ]);
            if (version === "candidate")
              assert.equal(
                await page.evaluate(differentPixels, captures[state]),
                0,
                `${name}/${theme}/${state} input pixels`
              );
          }
          await page.getByRole("button", { name: "Focus name", exact: true }).click();
          assert.equal(await page.getByLabel("Ref target").textContent(), "INPUT");
          assert.ok(await field("Name").evaluate((node) => document.activeElement === node));
          await field("Name").fill("Grace");
          assert.equal(await page.getByLabel("Name value").textContent(), "Grace");
          assert.ok(await field("Disabled").isDisabled());
          assert.ok(!(await field("Read only").isEditable()));
          await field("Read only").focus();
          await field("Read only").press("x");
          assert.equal(await field("Read only").inputValue(), "Read only");
          assert.ok(await field("Disabled notes").isDisabled());
          assert.ok(!(await field("Read only notes").isEditable()));
          await field("Read only notes").focus();
          await field("Read only notes").press("x");
          assert.equal(await field("Read only notes").inputValue(), "Read only\nSecond line");
          await page.locator('label[for="notes"]').click();
          assert.ok(await field("Notes").evaluate((node) => document.activeElement === node));
          await page.getByRole("button", { name: "Focus notes", exact: true }).click();
          assert.equal(await page.getByLabel("Multiline refs").textContent(), "LABEL/TEXTAREA");
          assert.ok(await field("Notes").evaluate((node) => document.activeElement === node));
          await field("Count").fill("0");
          assert.equal(await field("Count").evaluate((node) => node.checkValidity()), false);
          await field("Count").fill("5");
          assert.equal(await field("Count").evaluate((node) => node.checkValidity()), true);
          await field("Notes").fill("");
          await field("Email").fill("guest@example.test");
          await page.getByRole("button", { name: "Submit", exact: true }).click();
          assert.equal(await page.getByLabel("Submissions").textContent(), "0");
          await field("Notes").fill("Working notes\nSecond line");
          assert.equal(await page.getByLabel("Notes value").textContent(), "Working notes\nSecond line");
          await field("Email").fill("invalid");
          await page.getByRole("button", { name: "Submit", exact: true }).click();
          assert.equal(await page.getByLabel("Submissions").textContent(), "0");
          await field("Email").fill("guest@example.test");
          await page.getByRole("button", { name: "Submit", exact: true }).click();
          assert.equal(await page.getByLabel("Submissions").textContent(), "1");
          assert.deepEqual(errors, []);
        } finally {
          await context.close();
        }
      }
    }
  }
  console.log(
    "PASS native Input, Label and TextArea match the pinned source in 16 desktop/mobile, light/dark, rest/focus/hover/multiline comparisons with zero different pixels; label focus, typing, validation, sizing, disabled/read-only and refs pass."
  );
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
  const changesModule = `/@fs${fileURLToPath(new URL("../src/client/change-attempt.ts", import.meta.url))}`;
  for (const action of ["reschedule", "cancel"]) {
    const change = await sessionPage.evaluate(
      async ({ url, action }) => {
        const { ChangeAttempts } = await import(url);
        return new ChangeAttempts({ storage: sessionStorage, bookingId: "a".repeat(64) }).begin(
          action === "cancel"
            ? { action, version: 2 }
            : { action, version: 1, start: Date.UTC(2030, 0, 1, 12) }
        );
      },
      { url: changesModule, action }
    );
    await sessionPage.reload();
    const recovered = await sessionPage.evaluate(async (url) => {
      const { ChangeAttempts } = await import(url);
      return new ChangeAttempts({ storage: sessionStorage, bookingId: "a".repeat(64) }).read();
    }, changesModule);
    assert.deepEqual(recovered, change);
    assert.ok(!JSON.stringify(recovered).includes(receipt.saved.access.token));
    assert.equal(
      await sessionPage.evaluate(
        async ({ url, requestKey }) => {
          const { ChangeAttempts } = await import(url);
          const store = new ChangeAttempts({ storage: sessionStorage, bookingId: "a".repeat(64) });
          return store.acknowledge(requestKey) && store.read() === null;
        },
        { url: changesModule, requestKey: change.requestKey }
      ),
      true
    );
  }
  await sessionContext.close();
  console.log(
    "PASS native session storage preserves create/move/cancel requests across reload, removes acknowledged changes and replaces attendee data with a receipt."
  );
  for (const [name, viewport] of [
    ["desktop", { width: 1440, height: 900 }],
    ["mobile", { width: 390, height: 844 }],
  ]) {
    for (const theme of ["light", "dark"]) {
      for (const scenario of ["twelve", "twentyfour", "zone", "selected", "unavailable", "loading"]) {
        const captures = [];
        for (const version of ["reference", "candidate"]) {
          const context = await browser.newContext({ viewport, locale: "en-US", timezoneId: "UTC" });
          const page = await context.newPage();
          const errors = [];
          page.on("pageerror", (error) => errors.push(error.message));
          page.on("console", (message) => {
            if (message.type() === "error") errors.push(message.text());
          });
          const entry = version === "reference" ? "times.html" : "candidate-times.html";
          await page.goto(`${origin}/${entry}?case=${scenario}&theme=${theme}`);
          const buttons = page.getByTestId("time");
          await buttons.first().waitFor();
          await page.addStyleTag({
            content: "*, *::before, *::after { animation: none !important; transition: none !important; }",
          });
          await page.evaluate(() => document.fonts.ready);
          let expected = ["9:00am", "12:30pm", "11:00pm"];
          if (scenario === "twentyfour") expected = ["09:00", "12:30", "23:00"];
          if (scenario === "zone") expected = ["2:30pm", "6:00pm", "4:30am"];
          assert.deepEqual(await buttons.allTextContents(), expected);
          assert.equal(await buttons.nth(1).isDisabled(), ["loading", "unavailable"].includes(scenario));
          assert.equal(await buttons.first().isDisabled(), scenario === "loading");
          assert.equal(
            await page.locator('[data-testid="time"].border-brand-default').count(),
            scenario === "selected" ? 1 : 0
          );
          assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
          captures.push(
            Array.from(
              await page.screenshot({
                path: fileURLToPath(new URL(`${version}-times-${name}-${theme}-${scenario}.png`, artifacts)),
                fullPage: true,
              })
            )
          );
          if (version === "candidate")
            assert.equal(
              await page.evaluate(differentPixels, captures),
              0,
              `times ${name}/${theme}/${scenario} pixels`
            );
          if (["loading", "unavailable"].includes(scenario)) {
            await buttons.nth(1).evaluate((button) => button.click());
            assert.equal(await page.getByTestId("selection").textContent(), "none");
          }
          if (scenario !== "loading") {
            await buttons.first().click();
            assert.equal(await page.getByTestId("selection").textContent(), "2030-01-10T09:00:00Z");
            await buttons.nth(2).focus();
            await buttons.nth(2).press("Enter");
            assert.equal(await page.getByTestId("selection").textContent(), "2030-01-10T23:00:00Z");
          }
          assert.deepEqual(errors, []);
          await context.close();
        }
      }
    }
  }
  console.log(
    "PASS ordinary time rows match pinned source with zero different pixels, native selection and timezone/clock formatting across six states and four width/theme combinations."
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
