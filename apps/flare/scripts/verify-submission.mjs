import assert from "node:assert/strict";

export async function verifySubmission(browser, fixture, date) {
  const contexts = [],
    errors = [],
    consoles = [];
  const requests = [];
  const open = async () => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
    contexts.push(context);
    const page = await context.newPage();
    await page.clock.install({ time: date });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoles.push({ text: message.text(), url: message.location().url });
    });
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/bookings" && request.method() === "POST")
        requests.push(request.postDataJSON());
    });
    await page.goto(`${fixture.origin}/${fixture.settings.event.slug}`);
    await page.getByTestId("time").first().click();
    await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "name");
    await page.locator('label[for="booker-email"]').click();
    assert.ok(
      await page.getByLabel("Email", { exact: true }).evaluate((node) => document.activeElement === node)
    );
    await page.locator('label[for="booker-name"]').click();
    assert.ok(
      await page.getByLabel("Name", { exact: true }).evaluate((node) => document.activeElement === node)
    );
    await page.getByLabel("Name", { exact: true }).fill("Fixture Guest");
    await page.getByLabel("Email", { exact: true }).fill("guest@example.test");
    return page;
  };
  const saved = (page) =>
    page.evaluate(() =>
      JSON.parse(sessionStorage.getItem(`calflare:create:v1:${encodeURIComponent(location.pathname)}`))
    );
  try {
    const page = await open();
    const dialog = page.getByRole("dialog", { name: "Confirm your details", exact: true });
    for (const width of [390, 768, 769, 1280]) {
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await page.getByTestId("time").first().waitFor();
      await page.setViewportSize({ width, height: 844 });
      await page.getByTestId("time").first().click();
      if (width <= 768) {
        await dialog.waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("name") === "name");
        for (const key of ["Shift+Tab", "Tab", "Tab", "Tab", "Tab", "Tab", "Tab"]) {
          await page.keyboard.press(key);
          assert.ok(
            await dialog.evaluate(
              (node) => node.contains(document.activeElement) || document.activeElement === document.body
            ),
            "Native modal keyboard navigation never reaches background controls"
          );
        }
        await page.keyboard.press("Escape");
        await page.getByTestId("time").first().waitFor();
        await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "time");
        await page.getByTestId("time").first().click();
        await page.getByRole("button", { name: "Back", exact: true }).click();
      } else {
        assert.equal(await dialog.count(), 0);
        await page.keyboard.press("Escape");
        assert.ok(await page.getByLabel("Name", { exact: true }).isVisible());
        await page.getByRole("button", { name: "Back", exact: true }).click();
      }
      await page.getByTestId("time").first().waitFor();
      await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "time");
      await page.getByTestId("time").first().click();
      assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Fixture Guest");
    }
    await page.setViewportSize({ width: 390, height: 240 });
    await dialog.waitFor();
    assert.ok(
      await dialog.evaluate(
        (node) => node.clientHeight <= innerHeight * 0.8 && node.scrollHeight > node.clientHeight
      ),
      "Small-screen attendee dialog has bounded, scrollable content"
    );
    await page.getByRole("button", { name: "Confirm", exact: true }).focus();
    assert.ok(await dialog.evaluate((node) => node.scrollTop > 0));
    await page.setViewportSize({ width: 390, height: 844 });
    await page.mouse.click(1, 1);
    await page.getByTestId("time").first().click();
    await dialog.waitFor();
    assert.equal(await page.getByLabel("Email", { exact: true }).inputValue(), "guest@example.test");
    await page.getByLabel("Email", { exact: true }).fill("invalid");
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    assert.equal(requests.length, 0);
    await page.getByLabel("Email", { exact: true }).fill("guest@example.test");
    await page.getByRole("button", { name: "Back", exact: true }).click();
    await page.getByTestId("time").first().click();
    assert.equal(await page.getByLabel("Name", { exact: true }).inputValue(), "Fixture Guest");
    assert.equal(await page.getByLabel("Email", { exact: true }).inputValue(), "guest@example.test");
    await page.screenshot({
      path: new URL("../.verification/booking-form-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    const applied = Promise.withResolvers();
    const acknowledge = Promise.withResolvers();
    await page.route("**/api/bookings", async (route) => {
      try {
        const response = await route.fetch();
        applied.resolve({ status: response.status(), booking: await response.json() });
        await acknowledge.promise;
        await route.fulfill({ status: 200, contentType: "application/json", body: "truncated" });
      } catch (error) {
        applied.reject(error);
      }
    });
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    const original = await applied.promise;
    assert.equal(original.status, 201);
    await page.keyboard.press("Escape");
    await page.mouse.click(1, 1);
    assert.ok(await dialog.isVisible());
    assert.ok(await page.getByRole("button", { name: "Back", exact: true }).isDisabled());
    assert.equal(requests.length, 1);
    acknowledge.resolve();
    await page.getByRole("alert").waitFor();
    const pending = await saved(page);
    assert.equal(pending.kind, "pending");
    assert.equal(pending.request.requestKey, requests[0].requestKey);
    assert.equal(fixture.google.writes.length, 1);
    assert.ok(await page.getByRole("button", { name: "Back", exact: true }).isDisabled());
    assert.ok(await page.getByLabel("Name", { exact: true }).evaluate((input) => input.readOnly));
    assert.ok(await page.getByLabel("Email", { exact: true }).evaluate((input) => input.readOnly));
    await page.keyboard.press("Escape");
    await page.mouse.click(1, 1);
    assert.ok(await dialog.isVisible());
    assert.deepEqual(await saved(page), pending);
    assert.equal(await page.getByLabel("Time zone", { exact: true }).count(), 0);
    assert.equal(await page.getByTestId("event-meta").getByText("UTC", { exact: true }).count(), 1);
    await page.unroute("**/api/bookings");
    await page.reload();
    await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await page.getByLabel("Email", { exact: true }).inputValue(), "guest@example.test");
    assert.deepEqual(await saved(page), pending);
    await page.keyboard.press("Escape");
    await page.mouse.click(1, 1);
    assert.ok(await dialog.isVisible());
    assert.equal(requests.length, 1);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.deepEqual(requests[1], requests[0]);
    assert.equal(fixture.google.writes.length, 1);
    const receipt = await saved(page);
    assert.deepEqual(Object.keys(receipt).sort(), ["access", "kind", "requestKey"]);
    assert.equal(receipt.access.id, original.booking.id);
    assert.ok(!JSON.stringify(receipt).includes("guest@example.test"));
    assert.ok(!JSON.stringify(receipt).includes("Fixture Guest"));
    await page.reload();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(requests.length, 2);
    assert.equal(fixture.google.writes.length, 1);
    assert.ok(!(await page.content()).includes(receipt.access.token));
    assert.ok(!page.url().includes(receipt.access.token));
    await page.route(`**/api/bookings/${receipt.access.id}`, (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: "truncated" })
    );
    await page.reload();
    await page
      .getByRole("heading", { name: "Booking status is currently unavailable.", exact: true })
      .waitFor();
    assert.equal(
      await page.getByRole("heading", { name: "This booking is not confirmed yet.", exact: true }).count(),
      0
    );
    await page.unroute(`**/api/bookings/${receipt.access.id}`);
    await page.getByRole("button", { name: "Check booking status", exact: true }).click();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(fixture.google.writes.length, 1);
    await page.screenshot({
      path: new URL("../.verification/booking-receipt-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    assert.equal(await fixture.db.prepare("SELECT count(*) FROM booking").first("count(*)"), 1);
    const uncertain = await open();
    fixture.google.loseResponseAfter("insert");
    await uncertain.getByRole("button", { name: "Confirm", exact: true }).click();
    await uncertain
      .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
      .waitFor();
    assert.equal((await saved(uncertain)).kind, "receipt");
    assert.equal(
      await uncertain.getByRole("heading", { name: "This meeting is scheduled", exact: true }).count(),
      0
    );
    assert.equal(fixture.google.writes.length, 2);
    await uncertain.reload();
    await uncertain
      .getByRole("heading", { name: "This booking needs the organizer's attention.", exact: true })
      .waitFor();
    await uncertain.getByRole("button", { name: "Check booking status", exact: true }).click();
    await uncertain.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(fixture.google.writes.length, 2);
    const conflict = await open();
    const start = Date.parse(
      await conflict.getByTestId("event-meta").locator("time").getAttribute("datetime")
    );
    fixture.google.events.set("external-conflict", {
      id: "external-conflict",
      etag: '"external"',
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + 30 * 60_000).toISOString() },
    });
    await conflict.getByRole("button", { name: "Confirm", exact: true }).click();
    await conflict.getByRole("alert").filter({ hasText: "The event or time has changed" }).waitFor();
    assert.equal(await saved(conflict), null);
    assert.ok(await conflict.getByRole("button", { name: "Back", exact: true }).isEnabled());
    await conflict.getByRole("button", { name: "Back", exact: true }).click();
    await conflict.getByTestId("time").first().click();
    assert.equal(await conflict.getByLabel("Name", { exact: true }).inputValue(), "Fixture Guest");
    assert.equal(fixture.google.writes.length, 2);
    const before = requests.length;
    await conflict.evaluate(() => {
      Storage.prototype.setItem = () => {
        throw new DOMException("Blocked", "SecurityError");
      };
    });
    await conflict.getByRole("button", { name: "Confirm", exact: true }).click();
    await conflict
      .getByRole("alert")
      .filter({ hasText: "We couldn't restore or save this booking safely" })
      .waitFor();
    assert.equal(requests.length, before);
    assert.equal(fixture.google.writes.length, 2);
    assert.deepEqual(errors, []);
    assert.deepEqual(
      consoles.filter(
        (error) =>
          !(
            error.url === `${fixture.origin}/api/bookings` &&
            error.text.startsWith("Failed to load resource: the server responded with a status of 409")
          )
      ),
      []
    );
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    console.log(
      "PASS native attendee submission, persisted lost-response replay, receipt reload/PII removal, uncertain provider acknowledgment, conflict recovery and storage rejection. Actual built Worker/local D1; Google is mocked."
    );
  } finally {
    for (const context of contexts) await context.close();
  }
}
