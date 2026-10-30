import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyColumnPage(browser, referenceOrigin, artifacts, differentPixels, ready) {
  const fixedTime = Date.parse("2030-01-09T12:00:00Z");
  const fixture = await createWorkerFixture({ port: 8797, fixedTime });
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
        const errors = [];
        page.on("pageerror", (error) => errors.push(error.message));
        await page.clock.setFixedTime(new Date(fixedTime));
        await page.goto(`${referenceOrigin}/reference/intro?layout=column_view`);
        await ready(page, '[data-testid="time"]');
        const region = page.locator('[class*="grid-area:main"]');
        const capture = (name) =>
          region.screenshot({
            path: fileURLToPath(new URL(`${name}-column-page-${width}.png`, artifacts)),
          });
        const bounds = await region.boundingBox();
        const headers = await region.locator("header").allTextContents();
        assert.deepEqual(
          headers,
          width === 1280 ? ["Wed09", "Thu10", "Fri11", "Sat12", "Sun13", "Mon14"] : ["Wed09", "Thu10"]
        );
        const reference = [...(await capture("reference"))];
        await page.goto(`${fixture.origin}/intro`);
        await ready(page, '[data-testid="time"]');
        await page.getByRole("radio", { name: "Switch to column view" }).click();
        await ready(page, '[class*="grid-area:main"] [data-testid="time"]');
        assert.deepEqual(await region.boundingBox(), bounds);
        assert.deepEqual(await region.locator("header").allTextContents(), headers);
        assert.equal(
          await page.evaluate(differentPixels, [reference, [...(await capture("candidate"))]]),
          0,
          `${width} actual Next main-region RGBA`
        );
        await page.getByRole("button", { name: "Next Day", exact: true }).click();
        await expect(region.locator("header").first()).toHaveText(width === 1280 ? "Tue15" : "Fri11");
        await page.getByRole("button", { name: "Previous Day", exact: true }).click();
        await expect(region.locator("header").first()).toHaveText("Wed09");
        await page.getByRole("button", { name: "Previous Day", exact: true }).click();
        await expect(region.locator("header").first()).toHaveText("Wed09");
        const slot = region.getByTestId("time").last();
        const time = await slot.getAttribute("data-time");
        await slot.focus();
        await slot.press("Enter");
        const dialog = page.getByRole("dialog", { name: "Confirm your details" });
        await expect(dialog).toBeVisible();
        await expect(dialog.locator("time")).toHaveAttribute(
          "datetime",
          width === 1280 ? "2030-01-14T16:30:00.000Z" : "2030-01-10T16:30:00.000Z"
        );
        await expect(dialog.locator("time")).toHaveText(
          width === 1280 ? "Monday, January 14, 2030, 4:30 pm" : "Thursday, January 10, 2030, 4:30 pm"
        );
        await expect(dialog).toContainText("UTC");
        await page.getByLabel("Your name*", { exact: true }).fill("Column Guest");
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
        await expect(dialog).toHaveCount(0);
        await expect(page.locator(`[data-time="${time}"]`)).toBeFocused();
        await page.keyboard.press("Enter");
        await expect(page.getByLabel("Your name*", { exact: true })).toHaveValue("Column Guest");
        await page.keyboard.press("Escape");
        await expect(dialog).toHaveCount(0);
        if (width === 900) {
          await page.getByRole("button", { name: "30", exact: true }).click();
          for (const [action, expected] of [
            [null, ["Wed30", "Thu31"]],
            ["Next Day", ["Thu31", "Fri01, Feb"]],
            ["Next Day", ["Sat02", "Sun03"]],
            ["Previous Day", ["Thu31", "Fri01, Feb"]],
          ]) {
            if (action) await page.getByRole("button", { name: action, exact: true }).click();
            await expect(region.locator("header")).toHaveText(expected);
          }
        }
        await page.getByRole("radio", { name: "Switch to monthly view" }).click();
        await expect(region).toHaveCount(0);
        if (width === 900) {
          await page.getByRole("radio", { name: "Switch to column view" }).click();
          const selected = region.getByTestId("time").first();
          const instant = await selected.getAttribute("data-time");
          await selected.click();
          await page.getByLabel("Email address*", { exact: true }).fill("column@example.test");
          const requests = [];
          await page.route("**/api/events/default/bookings", async (route) => {
            requests.push(route.request().postDataJSON());
            assert.equal((await route.fetch()).status(), 201);
            await route.fulfill({ status: 200, contentType: "application/json", body: "truncated" });
          });
          await dialog.getByRole("button", { name: "Confirm", exact: true }).click();
          await expect(page.getByRole("alert")).toBeVisible();
          assert.equal(requests[0].start, Date.parse(instant));
          await page.keyboard.press("Escape");
          await page.mouse.click(1, 1);
          await expect(dialog).toBeVisible();
          await expect(dialog.getByRole("button", { name: "Back", exact: true })).toBeDisabled();
          await page.unroute("**/api/events/default/bookings");
          await page.reload();
          await expect(dialog).toBeVisible();
          await expect(dialog.locator("time")).toHaveAttribute("datetime", "2030-01-31T09:00:00.000Z");
          await expect(dialog.locator("time")).toHaveText("Thursday, January 31, 2030, 9:00 am");
          await expect(dialog).toContainText("UTC");
          const replay = page.waitForRequest("**/api/events/default/bookings");
          await dialog.getByRole("button", { name: "Retry", exact: true }).click();
          assert.deepEqual((await replay).postDataJSON(), requests[0]);
          await expect(page.getByRole("heading", { name: "This meeting is scheduled" })).toBeVisible();
        }
        assert.deepEqual(errors, []);
      } finally {
        await context.close();
      }
    }
    const context = await browser.newContext({ viewport: { width: 768, height: 900 }, timezoneId: "UTC" });
    try {
      const page = await context.newPage();
      await page.clock.setFixedTime(new Date(fixedTime));
      await page.goto(`${fixture.origin}/intro?layout=column_view`);
      await ready(page, '[data-testid="time"]');
      await expect(page.getByRole("radiogroup", { name: "Layout", exact: true })).toBeHidden();
      await page.getByTestId("time").first().press("Enter");
      await expect(page.getByRole("dialog", { name: "Confirm your details" })).toBeVisible();
      await page.keyboard.press("Escape");
      for (const [width, count] of [
        [769, 2],
        [1024, 2],
        [1025, 6],
      ]) {
        await page.setViewportSize({ width, height: 900 });
        await expect(page.locator('[class*="grid-area:main"] header')).toHaveCount(count);
      }
    } finally {
      await context.close();
    }
    const setOverrides = async (overrides) => {
      const schedule = { timeZone: "UTC", rules: [], overrides };
      assert.equal((await fixture.send("/api/owner", { ...settings, schedule }, owner, "PUT")).status, 200);
    };
    await setOverrides(
      ["2030-01-10", "2030-02-28", "2030-03-02"].map((date) => ({
        date,
        ranges: [{ startMinute: 540, endMinute: 570 }],
      }))
    );
    const sparse = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC" });
    try {
      const page = await sparse.newPage();
      await page.clock.setFixedTime(new Date(fixedTime));
      const initialRequest = page.waitForRequest("**/api/events/default/slots?*");
      await page.goto(`${fixture.origin}/intro?layout=column_view`);
      assert.equal(new URL((await initialRequest).url()).searchParams.get("to"), "2030-03-01T00:00:00.000Z");
      const region = page.locator('[class*="grid-area:main"]');
      await expect(region.locator("header")).toHaveText(["Thu10", "Thu28, Feb"]);
      const marchRequest = page.waitForRequest("**/api/events/default/slots?*");
      await page.getByRole("button", { name: "Next Day", exact: true }).click();
      const marchQuery = new URL((await marchRequest).url()).searchParams;
      assert.equal(marchQuery.get("from"), "2030-03-01T00:00:00.000Z");
      assert.equal(marchQuery.get("to"), "2030-05-01T00:00:00.000Z");
      await expect(region.locator("header")).toHaveText(["Sat02"]);
      await page.getByRole("button", { name: "Next Day", exact: true }).click();
      await expect(region.locator("header")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Next Day", exact: true })).toBeEnabled();
      await page.getByRole("button", { name: "Next Day", exact: true }).click();
      for (let i = 0; i < 8; i++)
        await page.getByRole("button", { name: "Previous Day", exact: true }).click();
      await expect(region.locator("header")).toHaveText(["Thu28", "Sat02, Mar"]);
      await setOverrides([{ date: "2030-01-09", ranges: [{ startMinute: 780, endMinute: 810 }] }]);
      await page.goto(`${fixture.origin}/intro?layout=column_view`);
      await expect(region.locator("header")).toHaveText(["Wed09"]);
      await page.getByRole("button", { name: "Next Day", exact: true }).click();
      await expect(region.locator("header")).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Previous Day", exact: true })).toBeEnabled();
      for (let i = 0; i < 11; i++) {
        await expect(page.getByRole("button", { name: "Next Day", exact: true })).toBeEnabled();
        await page.getByTestId("incrementMonth").click();
      }
      await expect(page.getByTestId("selected-month-label")).toHaveText("January 2031");
      await expect(page.getByRole("button", { name: "Next Day", exact: true })).toBeEnabled();
      await page.getByTestId("incrementMonth").click();
      await expect(page.getByRole("button", { name: "Next Day", exact: true })).toBeDisabled();
    } finally {
      await sparse.close();
    }
    assert.equal(fixture.google.writes.length, 1);
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
  } finally {
    await fixture.close();
  }
  console.log(
    "PASS built public column switching, actual Next main-region pixels, native pagination seam, keyboard dialog return/draft and responsive boundaries."
  );
}
