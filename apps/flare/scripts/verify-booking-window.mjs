import assert from "node:assert/strict";
import { expect } from "@playwright/test";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyBookingWindow(browser) {
  const fixedTime = Date.parse("2030-01-09T12:00:00Z");
  const fixture = await createWorkerFixture({ port: 8797, fixedTime });
  let context;
  try {
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
    const owner = await fixture.login();
    const original = fixture.settings;
    const configured = {
      ...original,
      event: {
        ...original.event,
        durationMinutes: 30,
        intervalMinutes: 30,
        beforeMinutes: 0,
        afterMinutes: 0,
        noticeMinutes: 0,
      },
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 540, endMinute: 600 })),
      },
    };
    await fixture.read(await fixture.send("/api/owner", configured, owner, "PUT"));
    await context.addCookies([
      { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
    ]);
    const page = await context.newPage(),
      errors = [],
      saves = [];
    await page.clock.install({ time: fixedTime });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/owner/booking-rules" && request.method() === "PATCH")
        saves.push(request.postDataJSON());
    });
    await page.goto(fixture.origin);
    const form = page.getByRole("form", { name: "Booking rules", exact: true });
    const limit = form.getByRole("checkbox", { name: "Limit future bookings", exact: true });
    const days = form.getByRole("spinbutton", { name: "Calendar days into the future", exact: true });
    const save = form.getByRole("button", { name: "Save", exact: true });
    await expect(limit).toBeEnabled();
    await expect(limit).not.toBeChecked();
    await limit.check();
    await expect(days).toHaveValue("30");
    for (const value of ["0", "366", "1.5", ""]) {
      await days.fill(value);
      await save.click();
      assert.equal(await days.evaluate((input) => input.checkValidity()), false);
      assert.equal(saves.length, 0, "Invalid days cannot reach HTTP");
    }
    await days.fill("7");
    await page.route(
      "**/api/owner/booking-rules",
      (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
      { times: 1 }
    );
    await save.click();
    await form.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    await expect(days).toHaveValue("7");
    await expect(limit).toBeChecked();
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.deepEqual(
      saves.map((input) => input.bookingWindowDays),
      [7, 7]
    );
    await page.reload();
    await expect(days).toHaveValue("7");
    await expect(days).toBeEnabled();
    await days.fill("30");
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    await page.reload();
    await expect(days).toHaveValue("30");
    await expect(limit).toBeChecked();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.ok(await days.evaluate((input) => input.getBoundingClientRect().width >= 200));
      await form.screenshot({
        path: new URL(`../.verification/booking-window-${width}.png`, import.meta.url).pathname,
        animations: "disabled",
      });
    }
    const publicPage = await context.newPage();
    await publicPage.clock.install({ time: fixedTime });
    const finalDay = new Date("2030-02-08T00:00:00Z");
    const nextDay = new Date(finalDay.getTime() + 86_400_000);
    await publicPage.goto(`${fixture.origin}/${configured.event.slug}`);
    await publicPage.getByTestId("time").first().waitFor();
    const month = publicPage.getByTestId("selected-month-label");
    for (
      let step = 0;
      step < 2 && (await month.getAttribute("datetime")) !== finalDay.toISOString().slice(0, 7);
      step++
    ) {
      const before = await month.getAttribute("datetime");
      await publicPage.getByTestId("incrementMonth").click();
      await expect(month).not.toHaveAttribute("datetime", before);
    }
    await expect(month).toHaveAttribute("datetime", finalDay.toISOString().slice(0, 7));
    await publicPage.getByRole("button", { name: String(finalDay.getUTCDate()), exact: true }).click();
    await expect(publicPage.getByTestId("time")).toHaveCount(2);
    assert.deepEqual(
      await publicPage
        .getByTestId("time")
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-time"))),
      [9, 9.5].map((hours) => new Date(finalDay.getTime() + hours * 3_600_000).toISOString())
    );
    const nextQuery = new URLSearchParams({
      from: nextDay.toISOString(),
      to: new Date(nextDay.getTime() + 86_400_000).toISOString(),
      timeZone: "UTC",
    });
    assert.deepEqual(await fixture.read(await fixture.request(`/api/slots?${nextQuery}`)), { slots: [] });
    if (nextDay.getUTCMonth() === finalDay.getUTCMonth())
      await expect(
        publicPage.getByRole("button", { name: String(nextDay.getUTCDate()), exact: true })
      ).toBeDisabled();
    await publicPage.getByTestId("time").last().click();
    await publicPage.getByLabel("Your name*", { exact: true }).fill("Window Guest");
    await publicPage.getByLabel("Email address*", { exact: true }).fill("window@example.test");
    const posted = publicPage.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === "/api/bookings" && response.request().method() === "POST"
    );
    await publicPage.getByRole("button", { name: "Confirm", exact: true }).click();
    const response = await posted;
    assert.equal(response.status(), 201);
    const booking = await response.json();
    assert.equal(booking.start, finalDay.getTime() + 9.5 * 3_600_000);
    assert.equal(booking.status, "confirmed");
    await publicPage.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    await limit.uncheck();
    await save.click();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal(saves.at(-1).bookingWindowDays, null);
    await page.reload();
    await expect(limit).not.toBeChecked();
    await expect(days).toHaveCount(0);
    const persisted = (await fixture.read(await fixture.request("/api/owner", { headers: owner }))).settings;
    assert.equal(Object.hasOwn(persisted.event, "bookingWindowDays"), false);
    assert.deepEqual(persisted.schedule, configured.schedule);
    assert.equal((await fixture.read(await fixture.request(`/api/slots?${nextQuery}`))).slots.length, 2);
    assert.equal(fixture.google.writes.length, 1);
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    console.log(
      "PASS rolling calendar-day owner enable/default/set/retry/reload/disable, invalid zero-write validation, readable 390/1280 and public final-day selection through confirmed booking. Built Worker/local D1; Google is mocked."
    );
  } finally {
    try {
      await context?.close();
    } finally {
      await fixture.close();
    }
  }
}
