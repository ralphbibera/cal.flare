import assert from "node:assert/strict";
import { verifyManagement } from "./verify-management.mjs";
import { verifyOwner } from "./verify-owner.mjs";
import { verifySubmission } from "./verify-submission.mjs";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyPublic(browser) {
  const fixture = await createWorkerFixture({ port: 8797 });
  let context;
  try {
    await verifyOwner(browser, fixture);
    const owner = await fixture.login();
    const settings = {
      ...fixture.settings,
      event: {
        ...fixture.settings.event,
        description: '<img src="/unexpected-image" onerror="alert(1)">',
      },
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 1380, endMinute: 1440 })),
      },
    };
    assert.equal((await fixture.send("/api/owner", settings, owner, "PUT")).status, 200);
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
    const page = await context.newPage();
    const browserDate = new Date();
    browserDate.setUTCMonth(browserDate.getUTCMonth() + 1, 1);
    browserDate.setUTCHours(0, 0, 0, 0);
    await page.clock.install({ time: browserDate });
    const errors = [],
      assets = [];
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") errors.push(message.text());
    });
    page.on("response", (response) => {
      if (new URL(response.url()).pathname.startsWith("/_astro/")) assets.push(response);
    });
    await page.goto(`${fixture.origin}/${settings.event.slug}`);
    await page.getByTestId("time").first().waitFor();
    assert.equal(await page.getByTestId("event-title").textContent(), settings.event.title);
    assert.equal(await page.locator('[data-testid="event-meta"] img').count(), 0);
    assert.ok((await page.getByTestId("event-meta").textContent()).includes(settings.event.description));
    assert.ok(
      await page.evaluate(async () => {
        await document.fonts.ready;
        return (
          document.fonts.check("14px Inter") && getComputedStyle(document.body).fontFamily.includes("Inter")
        );
      })
    );
    const first = await page.getByTestId("time").first().getAttribute("data-time");
    await page.getByTestId("time").first().click();
    assert.equal(await page.getByTestId("event-meta").locator("time").getAttribute("datetime"), first);
    await page.getByLabel("Name", { exact: true }).waitFor();
    await page.getByRole("button", { name: "Back", exact: true }).click();
    const zoneSelect = page.getByLabel("Time zone", { exact: true });
    const india = await zoneSelect.evaluate((select) =>
      ["Asia/Kolkata", "Asia/Calcutta"].find((zone) =>
        [...select.options].some((option) => option.value === zone)
      )
    );
    assert.ok(india);
    await zoneSelect.selectOption(india);
    await page.waitForFunction(
      () => document.querySelector('[data-testid="time"]')?.textContent === "4:30am"
    );
    const day = new Intl.DateTimeFormat("en-US", { day: "numeric", timeZone: india }).format(new Date(first));
    await page
      .getByTestId("day")
      .filter({ hasText: new RegExp(`^${day}$`) })
      .first()
      .click();
    const shifted = await page.getByTestId("time").first().getAttribute("data-time");
    assert.equal(shifted, first);
    await page.getByRole("button", { name: "24h", exact: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="time"]')?.textContent === "04:30");
    await page.getByTestId("time").first().focus();
    await page.keyboard.press("Enter");
    assert.equal(await page.getByTestId("event-meta").locator("time").getAttribute("datetime"), first);
    await page.getByRole("button", { name: "Back", exact: true }).click();
    for (const viewport of [
      { width: 390, height: 844 },
      { width: 768, height: 900 },
      { width: 1024, height: 900 },
      { width: 1280, height: 900 },
    ]) {
      await page.setViewportSize(viewport);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await page.screenshot({
      path: new URL("../.verification/public-booker-desktop.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.screenshot({
      path: new URL("../.verification/public-booker-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    assert.ok(assets.length > 0);
    for (const asset of assets)
      assert.equal(asset.status(), 200, `Built asset ${new URL(asset.url()).pathname}`);
    assert.deepEqual(errors, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    assert.equal(fixture.google.writes.length, 0);
    console.log(
      "PASS public Astro page SSR, hydration, built assets, private-data omission, escaped description, timezone labels and UTC selection. Local workerd/D1; Google is mocked."
    );
    await verifySubmission(browser, fixture, browserDate);
    await verifyManagement(browser, fixture, browserDate);
    await verifyPrivate(browser, fixture, browserDate);
    const alias = { ...settings, event: { ...settings.event, slug: "booking" } };
    assert.equal((await fixture.send("/api/owner", alias, owner, "PUT")).status, 200);
    assert.equal((await fixture.request("/booking")).status, 200);
  } finally {
    try {
      await context?.close();
    } finally {
      await fixture.close();
    }
  }
}

async function verifyPrivate(browser, fixture, date) {
  const contexts = [],
    errors = [],
    consoles = [];
  const open = async (options = {}) => {
    const context = await browser.newContext({
      viewport: { width: 390, height: 844 },
      timezoneId: "UTC",
      ...options,
    });
    contexts.push(context);
    const page = await context.newPage();
    await page.clock.install({ time: date });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("console", (message) => {
      if (message.type() === "error") consoles.push({ text: message.text(), url: message.location().url });
    });
    return page;
  };
  try {
    const source = await open({ permissions: ["clipboard-read", "clipboard-write"] });
    await source.goto(`${fixture.origin}/${fixture.settings.event.slug}`);
    await source.getByTestId("time").first().click();
    await source.getByLabel("Name", { exact: true }).fill("Private Guest");
    await source.getByLabel("Email", { exact: true }).fill("private@example.test");
    const before = fixture.google.writes.length;
    await source.getByRole("button", { name: "Confirm", exact: true }).click();
    await source.getByRole("button", { name: "Copy private booking link", exact: true }).click();
    await source.getByRole("status").filter({ hasText: "Link copied!" }).waitFor();
    const link = await source.evaluate(() => navigator.clipboard.readText());
    const parsed = new URL(link),
      token = parsed.hash.slice("#token=".length),
      id = parsed.pathname.split("/").at(-1);
    assert.match(token, /^[A-Za-z0-9_-]{43}$/);
    assert.match(id, /^[0-9a-f]{64}$/);
    assert.equal(parsed.origin, fixture.origin);
    assert.equal(parsed.pathname, `/booking/${id}`);
    assert.ok(!(await source.content()).includes(token));
    await source.evaluate(() =>
      Object.defineProperty(navigator, "clipboard", {
        value: {
          writeText: async () => {
            throw new Error("Clipboard denied");
          },
        },
      })
    );
    await source.getByRole("button", { name: "Copy private booking link", exact: true }).click();
    await source.getByRole("alert").filter({ hasText: "We couldn't copy this private link" }).waitFor();
    const shell = await fixture.request(parsed.pathname),
      html = await shell.text();
    assert.equal(shell.status, 200);
    assert.equal(shell.headers.get("cache-control"), "private, no-store");
    assert.equal(shell.headers.get("referrer-policy"), "no-referrer");
    assert.equal(shell.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
    for (const value of [token, "Private Guest", "private@example.test"]) assert.ok(!html.includes(value));
    assert.equal((await fixture.request("/booking/invalid")).status, 404);
    const guest = await open(),
      requests = [];
    guest.on("request", (request) => {
      requests.push(request.url());
      if (
        new URL(request.url()).pathname === `/api/bookings/${id}` &&
        request.headers().authorization !== `Bearer ${token}`
      )
        errors.push("Private view must use Bearer authorization");
    });
    await guest.goto(link);
    await guest.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(guest.url(), `${fixture.origin}${parsed.pathname}`);
    assert.ok((await guest.textContent("body")).includes("private@example.test"));
    assert.ok(!(await guest.content()).includes(token));
    assert.deepEqual(
      await guest.evaluate((id) => JSON.parse(sessionStorage.getItem(`calflare:manage:v1:${id}`)), id),
      { id, token }
    );
    await guest.reload();
    await guest.getByRole("button", { name: "Reschedule", exact: true }).click();
    await guest.getByTestId("time").first().waitFor();
    for (const width of [390, 768, 1024, 1280]) {
      await guest.setViewportSize({ width, height: 900 });
      assert.ok(await guest.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await guest.screenshot({
      path: new URL("../.verification/private-calendar-desktop.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    await guest.setViewportSize({ width: 390, height: 844 });
    await guest.locator('[data-testid="day"]:not(:disabled)').last().click();
    const time = guest.getByTestId("time").first();
    await time.waitFor();
    const selected = await time.getAttribute("data-time");
    await time.click();
    await guest.getByRole("button", { name: "Reschedule", exact: true }).click();
    await guest.waitForFunction(
      (selected) => document.querySelector("time")?.getAttribute("datetime") === selected,
      selected
    );
    await guest.getByRole("button", { name: "Cancel event", exact: true }).click();
    await guest.getByRole("button", { name: "Confirm", exact: true }).click();
    await guest.getByRole("heading", { name: "Canceled", exact: true }).waitFor();
    await guest.reload();
    await guest.getByRole("heading", { name: "Canceled", exact: true }).waitFor();
    assert.ok(requests.every((url) => !url.includes(token)));
    assert.deepEqual(
      fixture.google.writes.slice(before).map((write) => write.action),
      ["insert", "update", "delete"]
    );
    await guest.screenshot({
      path: new URL("../.verification/private-booking-mobile.png", import.meta.url).pathname,
      fullPage: true,
      animations: "disabled",
    });
    for (const mode of ["missing", "malformed", "wrong", "storage", "corrupt"]) {
      const denied = await open(),
        lookups = [];
      denied.on("request", (request) => {
        if (new URL(request.url()).pathname.startsWith("/api/bookings/")) lookups.push(request.url());
      });
      if (mode === "storage")
        await denied.addInitScript(() => {
          Storage.prototype.setItem = () => {
            throw new Error("Storage denied");
          };
        });
      if (mode === "corrupt")
        await denied.addInitScript(
          ({ id, token }) => {
            sessionStorage.setItem(`calflare:manage:v1:${id}`, JSON.stringify({ id: "b".repeat(64), token }));
          },
          { id, token }
        );
      const fragment =
        mode === "missing" || mode === "corrupt"
          ? ""
          : mode === "malformed"
            ? "#token=invalid"
            : mode === "wrong"
              ? `#token=${"A".repeat(43)}`
              : parsed.hash;
      await denied.goto(`${fixture.origin}${parsed.pathname}${fragment}`);
      await denied
        .getByRole("alert")
        .filter({ hasText: "Booking status is currently unavailable." })
        .waitFor();
      assert.equal(new URL(denied.url()).hash, "");
      const body = await denied.textContent("body");
      for (const value of ["private@example.test", "Private Guest", token]) assert.ok(!body.includes(value));
      assert.equal(lookups.length, mode === "wrong" ? 1 : 0);
    }
    assert.deepEqual(errors, []);
    assert.deepEqual(
      consoles.filter(
        (error) =>
          !(
            error.url === `${fixture.origin}/api/bookings/${id}` &&
            error.text.startsWith("Failed to load resource: the server responded with a status of 404")
          )
      ),
      []
    );
    assert.deepEqual(fixture.upstreamFailures, []);
    assert.deepEqual(fixture.google.denied, []);
    console.log(
      "PASS native copied private link, fresh-browser Bearer access, scrubbed URL, reload, reschedule/cancel and denied/storage-failure privacy. Built Worker/local D1; Google is mocked."
    );
  } finally {
    for (const context of contexts) await context.close();
  }
}
