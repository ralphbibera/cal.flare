import assert from "node:assert/strict";
import { apiFixture, settings } from "./fixtures/api.ts";

async function verifyCalendar(browser, origin) {
  const fixture = await apiFixture({ port: 8796 });
  let context;
  try {
    const policy = {
      ...settings,
      event: { ...settings.event, intervalMinutes: 30 },
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 1380, endMinute: 1440 })),
      },
    };
    const response = await fixture.send("/api/owner", policy, fixture.ownerHeaders, "PUT");
    assert.equal(response.status, 200);
    context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      locale: "en-US",
      timezoneId: "UTC",
    });
    const page = await context.newPage();
    const errors = [],
      requests = [];
    const consoleErrors = [],
      failedRequests = new Set();
    page.on("console", (message) => {
      if (message.type() === "error")
        consoleErrors.push({ text: message.text(), url: message.location().url });
    });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/slots") requests.push(new URL(request.url()));
    });
    await page.clock.install({ time: new Date("2030-01-01T00:00:00Z") });
    await page.addInitScript(() => {
      const original = window.fetch;
      window.fetch = (resource, init) => {
        // Let the delayed February response arrive despite cancellation to exercise the request fence.
        const url = new URL(String(resource), location.href);
        return original.call(
          window,
          resource,
          url.searchParams.get("from") === "2030-02-01T00:00:00.000Z" ? { ...init, signal: undefined } : init
        );
      };
    });
    const first = Promise.withResolvers(),
      permit = Promise.withResolvers();
    await page.route("**/api/slots?**", async (route) => {
      try {
        const response = await route.fetch();
        first.resolve();
        await permit.promise;
        await route.fulfill({ response });
      } catch (error) {
        first.reject(error);
      }
    });
    const initial = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/slots");
    await page.goto(`${origin}/calendar-api.html`);
    await initial;
    await first.promise;
    await page.getByRole("status").filter({ hasText: "Loading availability" }).waitFor();
    assert.equal(await page.getByTestId("time").count(), 0);
    permit.resolve();
    await page.getByTestId("time").first().waitFor();
    assert.deepEqual(await page.getByTestId("time").allTextContents(), ["11:00pm", "11:30pm"]);
    assert.equal(requests[0].searchParams.get("from"), "2030-01-01T00:00:00.000Z");
    assert.equal(requests[0].searchParams.get("to"), "2030-03-01T00:00:00.000Z");
    await page.unroute("**/api/slots?**");
    await page.getByTestId("time").first().click();
    assert.equal(await page.getByTestId("selection").textContent(), "2030-01-01T23:00:00.000Z");
    await page.getByLabel("Time zone").selectOption("Asia/Kolkata");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="time"]')?.textContent === "4:30am"
    );
    assert.equal(
      await page.getByTestId("time").first().getAttribute("data-time"),
      "2030-01-01T23:00:00.000Z"
    );
    assert.equal(await page.locator('[data-testid="day"].bg-brand-default').textContent(), "2");
    assert.equal(requests.at(-1).searchParams.get("from"), "2029-12-31T18:30:00.000Z");
    await page.getByLabel("Time zone").selectOption("UTC");
    await page.waitForFunction(
      () => document.querySelector('[data-testid="time"]')?.textContent === "11:00pm"
    );
    const held = Promise.withResolvers();
    await page.route("**/api/slots?**", async (route) => {
      if (new URL(route.request().url()).searchParams.get("from") !== "2030-02-01T00:00:00.000Z")
        return route.continue();
      try {
        held.resolve({ route, response: await route.fetch() });
      } catch (error) {
        held.reject(error);
      }
    });
    await page.getByTestId("incrementMonth").click();
    const delayed = await held.promise;
    assert.equal(await page.getByTestId("time").count(), 0);
    await page.getByTestId("incrementMonth").click();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="time"]')?.getAttribute("data-time") ===
        "2030-03-01T23:00:00.000Z"
    );
    const oldResponse = page.waitForResponse((response) => response.url() === delayed.route.request().url());
    await delayed.route.fulfill({ response: delayed.response });
    await (await oldResponse).finished();
    await page.evaluate(
      () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    );
    assert.equal(await page.getByTestId("selected-month-label").getAttribute("datetime"), "2030-03");
    assert.equal(await page.getByTestId("time").count(), 2);
    assert.equal(
      await page.getByTestId("time").first().getAttribute("data-time"),
      "2030-03-01T23:00:00.000Z"
    );
    await page.unroute("**/api/slots?**");
    await page.route("**/api/slots?**", (route) => {
      failedRequests.add(route.request().url());
      return route.fulfill({
        status: 503,
        contentType: "application/json",
        body: '{"error":"calendar_unavailable"}',
      });
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("alert").waitFor();
    assert.equal(await page.getByTestId("time").count(), 0);
    assert.ok(!(await page.getByRole("alert").textContent()).includes("calendar_unavailable"));
    await page.unroute("**/api/slots?**");
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByTestId("time").first().waitFor();
    const poll = page.waitForResponse((response) => new URL(response.url()).pathname === "/api/slots");
    await page.clock.fastForward(300_000);
    await (await poll).finished();
    fixture.calendar.events.set("busy", {
      id: "busy",
      etag: '"busy"',
      start: { dateTime: "2030-01-01T00:00:00Z" },
      end: { dateTime: "2031-01-01T00:00:00Z" },
    });
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.getByRole("status").filter({ hasText: "No available times" }).waitFor();
    assert.equal(await page.getByTestId("time").count(), 0);
    fixture.calendar.events.clear();
    assert.equal(
      (
        await fixture.send(
          "/api/owner",
          {
            ...policy,
            schedule: {
              ...policy.schedule,
              overrides: Array.from({ length: 31 }, (_, day) => ({
                date: `2030-01-${String(day + 1).padStart(2, "0")}`,
                ranges: [],
              })),
            },
          },
          fixture.ownerHeaders,
          "PUT"
        )
      ).status,
      200
    );
    await page.reload();
    await page.waitForFunction(
      () =>
        document.querySelector('[data-testid="time"]')?.getAttribute("data-time") ===
        "2030-02-01T23:00:00.000Z"
    );
    assert.equal(await page.getByTestId("selected-month-label").getAttribute("datetime"), "2030-02");
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    await page.screenshot({
      path: new URL("../.verification/calendar-api-mobile.png", import.meta.url).pathname,
      fullPage: true,
    });
    await page.getByRole("button", { name: "Hide calendar" }).click();
    const before = requests.length;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await page.clock.fastForward(300_000);
    await page.evaluate(() => new Promise(requestAnimationFrame));
    assert.equal(requests.length, before);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      consoleErrors.filter(
        (error) =>
          !(
            failedRequests.has(error.url) &&
            error.text.startsWith("Failed to load resource: the server responded with a status of 503")
          )
      ),
      []
    );
    assert.equal(fixture.calendar.writes.length, 0);
    console.log(
      "PASS booking calendar loads real HTTP/D1 availability, groups visitor dates, selects UTC slots, fences late responses, retries failures and cleans up refresh work. Calendar is faked."
    );
  } finally {
    try {
      await context?.close();
    } finally {
      await fixture.close();
    }
  }
}

export { verifyCalendar };
