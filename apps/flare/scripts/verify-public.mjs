import assert from "node:assert/strict";
import { verifyManagement } from "./verify-management.mjs";
import { verifySubmission } from "./verify-submission.mjs";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyPublic(browser) {
  const fixture = await createWorkerFixture({ port: 8797 });
  let context;
  try {
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
  } finally {
    try {
      await context?.close();
    } finally {
      await fixture.close();
    }
  }
}
