import assert from "node:assert/strict";

export async function verifyManagement(browser, fixture, date) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
  const errors = [],
    requests = [];
  try {
    const page = await context.newPage();
    await page.clock.install({ time: date });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    await page.goto(`${fixture.origin}/${fixture.settings.event.slug}`);
    await page.getByTestId("time").first().click();
    await page.getByLabel("Name", { exact: true }).fill("Management Guest");
    await page.getByLabel("Email", { exact: true }).fill("management@example.test");
    const before = fixture.google.writes.length;
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    const receipt = await page.evaluate(() =>
      JSON.parse(sessionStorage.getItem(`calflare:create:v1:${encodeURIComponent(location.pathname)}`))
    );
    const path = `/api/bookings/${receipt.access.id}`;
    const saved = () =>
      page.evaluate(
        (id) => JSON.parse(sessionStorage.getItem(`calflare:change:v1:${id}`)),
        receipt.access.id
      );
    const currentTime = () => page.getByTestId("event-meta").locator("time").getAttribute("datetime");
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === path && request.method() === "POST") {
        requests.push(request.postDataJSON());
        if (request.headers().authorization !== `Bearer ${receipt.access.token}`)
          errors.push("Missing management authorization");
      }
    });
    const choose = async () => {
      const previous = await currentTime();
      await page.getByRole("button", { name: "Reschedule", exact: true }).click();
      const slots = page.getByTestId("time");
      await slots.first().waitFor();
      for (const width of [390, 768, 1024, 1280]) {
        await page.setViewportSize({ width, height: 900 });
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({
        path: new URL("../.verification/management-calendar-mobile.png", import.meta.url).pathname,
        fullPage: true,
        animations: "disabled",
      });
      for (let i = 0; i < (await slots.count()); i++) {
        const time = await slots.nth(i).getAttribute("data-time");
        if (time !== previous) {
          await slots.nth(i).click();
          return time;
        }
      }
      await page.locator('[data-testid="day"]:not(:disabled)').last().click();
      await page.waitForFunction(
        (previous) => document.querySelector('[data-testid="time"]')?.getAttribute("data-time") !== previous,
        previous
      );
      const time = await slots.first().getAttribute("data-time");
      assert.ok(time && time !== previous);
      await slots.first().click();
      return time;
    };
    let selected = await choose();
    assert.ok(selected);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    assert.equal(requests.length, 0);
    selected = await choose();
    assert.ok(selected);
    for (const action of ["reschedule", "cancel"]) {
      const previousRequests = requests.length;
      if (action === "cancel") {
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        await page.getByRole("button", { name: "Back", exact: true }).click();
        assert.equal(requests.length, previousRequests);
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
        await page.evaluate(() => {
          Storage.prototype.setItem = () => {
            throw new Error("Storage denied");
          };
        });
        await page.getByRole("button", { name: "Confirm", exact: true }).click();
        await page
          .getByRole("alert")
          .filter({ hasText: "We couldn't restore or save this booking safely" })
          .waitFor();
        assert.equal(requests.length, previousRequests);
        await page.reload();
        await page.getByRole("button", { name: "Cancel event", exact: true }).click();
      }
      const applied = Promise.withResolvers();
      await page.route(`**${path}`, async (route) => {
        if (route.request().method() !== "POST") {
          await route.continue();
          return;
        }
        try {
          const response = await route.fetch();
          applied.resolve({ status: response.status(), booking: await response.json() });
          await route.fulfill({ status: 200, contentType: "application/json", body: "truncated" });
        } catch (error) {
          applied.reject(error);
        }
      });
      await page
        .getByRole("button", { name: action === "cancel" ? "Confirm" : "Reschedule", exact: true })
        .click();
      const result = await applied.promise;
      assert.equal(result.status, 200);
      assert.equal(result.booking.status, action === "cancel" ? "cancelled" : "confirmed");
      assert.equal(result.booking.start, Date.parse(selected));
      await page.getByRole("alert").waitFor();
      const pending = await saved(),
        writes = fixture.google.writes.length;
      assert.equal(pending.action, action);
      assert.deepEqual(pending, requests.at(-1));
      assert.equal(await page.getByRole("button", { name: "Back", exact: true }).count(), 0);
      assert.equal(await page.getByRole("button", { name: "Cancel event", exact: true }).count(), 0);
      assert.equal(
        await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).count(),
        0
      );
      await page.reload();
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      assert.deepEqual(await saved(), pending);
      assert.equal(fixture.google.writes.length, writes);
      assert.equal(requests.length, previousRequests + 1);
      await page.unroute(`**${path}`);
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await page
        .getByRole("heading", {
          name: action === "cancel" ? "Canceled" : "This meeting is scheduled",
          exact: true,
        })
        .waitFor();
      assert.deepEqual(requests.at(-1), requests.at(-2));
      assert.equal(await saved(), null);
      assert.equal(await currentTime(), selected);
      assert.equal(fixture.google.writes.length, writes);
      assert.ok(!(await page.content()).includes(receipt.access.token));
      assert.ok(!page.url().includes(receipt.access.token));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: new URL(`../.verification/management-${action}-mobile.png`, import.meta.url).pathname,
        fullPage: true,
        animations: "disabled",
      });
      if (action === "reschedule") {
        selected = await choose();
        assert.ok(selected);
        fixture.google.loseResponseAfter("update");
        await page.getByRole("button", { name: "Reschedule", exact: true }).click();
        await page
          .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
          .waitFor();
        const writes = fixture.google.writes.length;
        assert.equal(await saved(), null);
        assert.equal(
          await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).count(),
          0
        );
        assert.equal(await page.getByRole("button", { name: "Cancel event", exact: true }).count(), 0);
        await page.reload();
        await page
          .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
          .waitFor();
        await page.getByRole("button", { name: "Check booking status", exact: true }).click();
        await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
        assert.equal(await currentTime(), selected);
        assert.equal(fixture.google.writes.length, writes);
      }
    }
    await page.reload();
    await page.getByRole("heading", { name: "Canceled", exact: true }).waitFor();
    assert.equal(await page.getByRole("button", { name: "Reschedule", exact: true }).count(), 0);
    assert.equal(await page.getByRole("button", { name: "Cancel event", exact: true }).count(), 0);
    assert.deepEqual(
      fixture.google.writes.slice(before).map((write) => write.action),
      ["insert", "update", "update", "delete"]
    );
    assert.equal(
      await fixture.db
        .prepare("SELECT count(*) FROM booking_command WHERE booking_id=?")
        .bind(receipt.access.id)
        .first("count(*)"),
      4
    );
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    console.log(
      "PASS native receipt reschedule/cancel, confirmation, storage rejection and exact replay after lost responses/reloads without duplicate Calendar writes. Built Worker/local D1; Google is mocked."
    );
  } finally {
    await context.close();
  }
}
