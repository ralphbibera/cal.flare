import assert from "node:assert/strict";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { differentPixels } from "./different-pixels.mjs";
import { ready as settled } from "./verify-upstream.mjs";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyWeekPage(browser) {
  const fixedTime = Date.parse("2030-01-09T12:00:00Z");
  const fixture = await createWorkerFixture({ port: 8797, fixedTime });
  const artifacts = new URL("../.verification/", import.meta.url);
  try {
    const owner = await fixture.login();
    const settings = {
      ...fixture.settings,
      event: {
        ...fixture.settings.event,
        title: "Intro call",
        slug: "intro",
        description: "A short conversation.",
        durationMinutes: 30,
        intervalMinutes: 30,
        noticeMinutes: 1,
        beforeMinutes: 0,
        afterMinutes: 0,
      },
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 540, endMinute: 1020 })),
      },
    };
    assert.equal((await fixture.send("/api/owner", settings, owner, "PUT")).status, 200);
    for (const width of [1280, 900]) {
      const context = await browser.newContext({
        viewport: { width, height: 900 },
        locale: "en-US",
        timezoneId: "UTC",
        colorScheme: "light",
      });
      try {
        const page = await context.newPage();
        const errors = [],
          queries = [],
          commands = [];
        page.on("pageerror", (error) => errors.push(error.message));
        page.on("console", (message) => {
          if (message.type() === "error") errors.push(message.text());
        });
        page.on("request", (request) => {
          const url = new URL(request.url());
          if (url.pathname === "/api/slots") queries.push(url);
          if (url.pathname === "/api/bookings" && request.method() === "POST")
            commands.push(request.postDataJSON());
        });
        await page.clock.setFixedTime(new Date(fixedTime));
        const region = page.locator('[class*="grid-area:main"]');
        const cells = region.getByTestId("calendar-empty-cell");
        const headers = region.locator(".auto-cols-fr > div:not(:first-child)");
        const ready = async () => {
          await expect(cells.first()).toBeAttached();
          await page.evaluate(() => document.fonts.ready);
          await page.waitForFunction(() => scrollY > 0);
          await page.evaluate(() => scrollTo(0, 0));
          await page.mouse.move(0, 0);
          await settled(page, '[data-testid="calendar-empty-cell"]');
        };
        const capture = async (name) =>
          page.screenshot({
            clip: await region.boundingBox(),
            fullPage: true,
            path: fileURLToPath(new URL(`${name}-week-page-${width}.png`, artifacts)),
            animations: "disabled",
          });
        let reference, bounds;
        if (process.env.CALFLARE_REFERENCE_ORIGIN) {
          assert.equal(process.env.CALFLARE_REFERENCE_ORIGIN, "http://127.0.0.1:18800");
          await page.goto(`${process.env.CALFLARE_REFERENCE_ORIGIN}/reference/intro?layout=week_view`);
          await ready();
          bounds = await region.boundingBox();
          reference = [...(await capture("reference"))];
        }
        await page.goto(`${fixture.origin}/intro?layout=week_view`);
        await ready();
        await expect(headers).toHaveText(
          width === 1280
            ? ["Wed 09", "Thu 10", "Fri 11", "Sat 12", "Sun 13", "Mon 14", "Tue 15"]
            : ["Wed 09", "Thu 10", "Fri 11", "Sat 12"]
        );
        assert.equal(await cells.count(), width === 1280 ? 105 : 57);
        const candidateBounds = await region.boundingBox();
        const candidate = [...(await capture("candidate"))];
        if (reference) {
          assert.deepEqual(candidateBounds, bounds);
          assert.equal(
            await page.evaluate(differentPixels, [reference, candidate]),
            0,
            `${width} actual Next week main-region RGBA`
          );
          console.log(`PASS actual Next week ${width}: identical bounds and every RGBA channel`);
        }
        for (const [name, layout] of [
          ["column", "column_view"],
          ["monthly", "month_view"],
          ["weekly", "week_view"],
        ]) {
          await page.getByRole("radio", { name: `Switch to ${name} view`, exact: true }).click();
          assert.equal(new URL(page.url()).searchParams.get("layout"), layout);
        }
        await expect(cells).toHaveCount(width === 1280 ? 105 : 57);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), width);
        assert.equal(await page.evaluate(() => document.documentElement.scrollHeight), 1541);
        assert.equal(
          await region.evaluate(
            (node) =>
              [...node.querySelectorAll("*")].filter(
                (child) =>
                  ["auto", "scroll"].includes(getComputedStyle(child).overflowY) &&
                  child.scrollHeight > child.clientHeight
              ).length
          ),
          0
        );
        await page.evaluate(() => scrollTo(0, 641));
        assert.equal(
          await region
            .locator(".sticky.flex-none")
            .first()
            .evaluate((node) => node.getBoundingClientRect().top),
          66
        );
        await page.getByRole("button", { name: "Next Day", exact: true }).click();
        await expect(headers.first()).toHaveText(width === 1280 ? "Wed 16" : "Sun 13");
        await page.getByRole("button", { name: "Previous Day", exact: true }).click();
        await expect(headers.first()).toHaveText("Wed 09");
        await page.getByRole("button", { name: "Previous Day", exact: true }).click();
        await expect(headers.first()).toHaveText("Wed 09");
        await page.getByRole("button", { name: "30", exact: true }).click();
        await expect(headers).toHaveText(
          width === 1280
            ? ["Wed 30", "Thu 31", "Fri 01", "Sat 02", "Sun 03", "Mon 04", "Tue 05"]
            : ["Wed 30", "Thu 31", "Fri 01", "Sat 02"]
        );
        await page.getByRole("button", { name: "Next Day", exact: true }).click();
        await expect(headers.first()).toHaveText(width === 1280 ? "Wed 06" : "Sun 03");
        await page.getByRole("button", { name: "Previous Day", exact: true }).click();
        await expect(headers.first()).toHaveText("Wed 30");
        await page.getByRole("button", { name: "Today", exact: true }).click();
        const slot = region.locator('[data-slot="2030-01-10T09:00:00.000Z"]');
        await expect(slot).toHaveCSS("top", "522px");
        await page.getByRole("radio", { name: "24h", exact: true }).click();
        await expect(slot).toHaveAttribute("aria-label", /09:00/);
        await expect(slot).toHaveCSS("top", "522px");
        await page.getByRole("radio", { name: "12h", exact: true }).click();
        await page.getByRole("combobox", { name: "Time zone", exact: true }).fill("Kolkata");
        await page.keyboard.press("Enter");
        await expect(slot).toHaveAttribute("aria-label", /2:30pm, Asia\/Kolkata/);
        await expect(slot).toHaveCSS("top", "841px");
        await slot.focus();
        await slot.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Confirm your details" });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator("time")).toHaveAttribute("datetime", "2030-01-10T09:00:00.000Z");
        await expect(dialog.locator("time")).toHaveText("Thursday, January 10, 2030, 2:30 pm");
        await expect(dialog).toContainText("Asia/Kolkata");
        await expect(page.locator("#booker-time-zone")).toBeDisabled();
        await dialog.getByLabel("Your name*", { exact: true }).fill("Week Guest");
        await dialog.getByLabel("Email address*", { exact: true }).fill("week@example.test");
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
        await expect(slot).toBeFocused();
        await page.keyboard.press("Space");
        await expect(dialog.getByLabel("Your name*", { exact: true })).toHaveValue("Week Guest");
        await page.keyboard.press("Escape");
        await expect(slot).toBeFocused();
        await page.keyboard.press("Enter");
        for (const resized of [768, 769, 1024, 1025]) {
          await page.setViewportSize({ width: resized, height: 900 });
          await expect(dialog).toBeVisible();
          await expect(dialog.locator('time[datetime="2030-01-10T09:00:00.000Z"]')).toHaveCount(1);
          await expect(dialog.getByLabel("Your name*", { exact: true })).toHaveValue("Week Guest");
        }
        await page.keyboard.press("Escape");
        await expect(headers).toHaveCount(7);
        await page.setViewportSize({ width: 768, height: 900 });
        await expect(page.getByRole("radiogroup", { name: "Layout", exact: true })).toBeHidden();
        await expect(region).toHaveCount(0);
        await page.screenshot({
          path: fileURLToPath(new URL(`week-mobile-fallback-${width}.png`, artifacts)),
          fullPage: true,
        });
        for (const [resized, count] of [
          [769, 4],
          [1024, 4],
          [1025, 7],
        ]) {
          await page.setViewportSize({ width: resized, height: 900 });
          await expect(headers).toHaveCount(count);
        }
        assert.equal(commands.length, 0);
        if (width === 1280) {
          await page.goto(`${fixture.origin}/intro?layout=week_view`);
          for (let month = 1; month <= 11; month++) {
            await expect(page.getByRole("button", { name: "Next Day", exact: true })).toBeEnabled();
            await page.getByTestId("incrementMonth").click();
            await expect(page.getByTestId("selected-month-label")).toHaveAttribute(
              "datetime",
              `2030-${String(month + 1).padStart(2, "0")}`
            );
          }
          await page.getByRole("button", { name: "30", exact: true }).click();
          await expect(headers).toHaveText([
            "Mon 30",
            "Tue 31",
            "Wed 01",
            "Thu 02",
            "Fri 03",
            "Sat 04",
            "Sun 05",
          ]);
          await page.getByRole("button", { name: "Next Day", exact: true }).click();
          await expect(headers.first()).toHaveText("Mon 06");
          await page.getByRole("button", { name: "Today", exact: true }).click();
          const sparse = {
            timeZone: "UTC",
            rules: [],
            overrides: [{ date: "2030-01-10", ranges: [{ startMinute: 540, endMinute: 570 }] }],
          };
          assert.equal(
            (await fixture.send("/api/owner", { ...settings, schedule: sparse }, owner, "PUT")).status,
            200
          );
          await page.reload();
          await expect(cells).toHaveCount(1);
          await expect(headers).toHaveCount(7);
          await page.getByRole("button", { name: "Next Day", exact: true }).click();
          await expect(headers.first()).toHaveText("Wed 16");
          await expect(cells).toHaveCount(0);
          await expect(page.getByRole("status").filter({ hasText: "No available" })).toBeVisible();
          await page.getByRole("button", { name: "Previous Day", exact: true }).click();
          await expect(cells).toHaveCount(1);
          const release = Promise.withResolvers();
          await page.route("**/api/slots?**", async (route) => {
            await release.promise;
            await route.fulfill({ status: 200, contentType: "application/json", body: "{}" });
          });
          try {
            const requested = page.waitForRequest("**/api/slots?**");
            await page.getByRole("combobox", { name: "Time zone", exact: true }).fill("Kolkata");
            await page.keyboard.press("Enter");
            await requested;
            await expect(region).toHaveAttribute("aria-busy", "true");
            await expect(cells).toHaveCount(0);
            await expect(headers).toHaveCount(7);
            await expect(page.getByRole("button", { name: "Next Day", exact: true })).toBeDisabled();
          } finally {
            release.resolve();
          }
          await expect(page.getByRole("alert")).toBeVisible();
          await expect(cells).toHaveCount(0);
          await page.unroute("**/api/slots?**");
          const retried = page.waitForResponse("**/api/slots?**");
          await page.getByRole("button", { name: "Retry", exact: true }).click();
          const response = await retried;
          assert.equal(response.status(), 200);
          await expect(cells).toHaveCount(1);
          await expect(cells.first()).toHaveAttribute("aria-label", /2:30pm, Asia\/Kolkata/);
          await expect(cells.first()).toHaveCSS("top", "841px");
          assert.equal((await fixture.send("/api/owner", settings, owner, "PUT")).status, 200);
        }
        if (width === 900) {
          await slot.click();
          await page.screenshot({
            path: fileURLToPath(new URL("week-dialog.png", artifacts)),
            fullPage: true,
          });
          await page.route("**/api/bookings", async (route) => {
            assert.equal((await route.fetch()).status(), 201);
            await route.fulfill({ status: 200, contentType: "application/json", body: "truncated" });
          });
          await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
          await expect(dialog.getByRole("alert")).toBeVisible();
          assert.equal(commands[0].start, Date.parse("2030-01-10T09:00:00Z"));
          assert.equal(commands[0].timeZone, "Asia/Kolkata");
          await page.keyboard.press("Escape");
          await page.mouse.click(1, 1);
          await expect(dialog).toBeVisible();
          await expect(dialog.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
          await page.unroute("**/api/bookings");
          await page.reload();
          await expect(dialog).toBeVisible();
          await expect(dialog).toContainText("Asia/Kolkata");
          await expect(dialog.locator("time")).toHaveText("Thursday, January 10, 2030, 2:30 pm");
          await dialog.getByRole("button", { name: "Retry", exact: true }).click();
          await expect(page.getByRole("heading", { name: "This meeting is scheduled" })).toBeVisible();
          assert.deepEqual(commands[1], commands[0]);
        }
        for (const url of queries) {
          const from = Date.parse(url.searchParams.get("from")),
            to = Date.parse(url.searchParams.get("to"));
          assert.ok(to > from && to - from <= 63 * 86400000);
          assert.ok(to <= fixedTime + 365 * 86400000);
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
    assert.equal(fixture.google.writes.length, 1);
    assert.deepEqual(fixture.google.denied, []);
    assert.deepEqual(fixture.upstreamFailures, []);
  } finally {
    await fixture.close();
  }
  console.log(
    "PASS built public week URL, responsive dates, fixed paging/seam, UTC fractional-zone placement, keyboard dialog return/draft and locked identical pending replay. Built Worker/local D1; Google is mocked."
  );
}
