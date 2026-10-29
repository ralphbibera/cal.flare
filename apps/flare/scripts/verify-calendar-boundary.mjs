import assert from "node:assert/strict";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyCalendarBoundary(browser) {
  const now = Date.parse("2099-12-31T12:00:00.000Z");
  const fixture = await createWorkerFixture({ port: 8797, fixedTime: now });
  const contexts = [];
  try {
    const owner = await fixture.login();
    const settings = {
      ...fixture.settings,
      event: {
        ...fixture.settings.event,
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
    const providerQueries = [];
    const googleFetch = fixture.google.fetch;
    fixture.google.fetch = (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/calendar/v3/calendars/primary/events" && request.method === "GET")
        providerQueries.push(url);
      return googleFetch(request);
    };
    for (const zone of ["Asia/Tokyo", "UTC"]) {
      const context = await browser.newContext({ timezoneId: zone, locale: "en-US" });
      contexts.push(context);
      const page = await context.newPage();
      await page.clock.install({ time: now });
      const requests = [];
      page.on("request", (request) => {
        const url = new URL(request.url());
        if (url.pathname === "/api/slots") requests.push(url);
      });
      await page.goto(`${fixture.origin}/${settings.event.slug}?layout=column_view`);
      await page.getByTestId("time").first().waitFor();
      assert.equal(
        await page.locator('[class*="grid-area:main"] header').count(),
        zone === "Asia/Tokyo" ? 2 : 1
      );
      assert.equal(await page.getByTestId("selected-month-label").getAttribute("datetime"), "2099-12");
      const countBeforeNavigation = requests.length;
      await page.getByTestId("incrementMonth").click();
      await page.waitForFunction(
        () =>
          document.querySelector('[data-testid="selected-month-label"]')?.getAttribute("datetime") ===
          "2100-01"
      );
      if (zone === "Asia/Tokyo") {
        await page.getByTestId("time").first().waitFor();
        const query = requests.at(-1);
        assert.equal(query.searchParams.get("from"), "2099-12-31T15:00:00.000Z");
        assert.equal(query.searchParams.get("to"), "2100-01-01T00:00:00.000Z");
        assert.deepEqual(
          await page
            .getByTestId("time")
            .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("data-time"))),
          [
            "2099-12-31T15:00:00.000Z",
            "2099-12-31T15:30:00.000Z",
            "2099-12-31T16:00:00.000Z",
            "2099-12-31T16:30:00.000Z",
          ]
        );
        assert.deepEqual(await page.getByTestId("time").allTextContents(), [
          "12:00am",
          "12:30am",
          "1:00am",
          "1:30am",
        ]);
        await page.getByTestId("time").first().click();
        const dialog = page.getByRole("dialog", { name: "Confirm your details" });
        assert.equal(await dialog.locator("time").getAttribute("datetime"), "2099-12-31T15:00:00.000Z");
        await dialog.getByRole("button", { name: "Back", exact: true }).click();
      } else {
        await page.getByRole("status").filter({ hasText: "No available" }).waitFor();
        assert.equal(await page.getByTestId("time").count(), 0);
        assert.equal(requests.length, countBeforeNavigation);
      }
      assert.equal(await page.getByRole("button", { name: "Next Day", exact: true }).isDisabled(), true);
      assert.equal(await page.getByRole("button", { name: "Previous Day", exact: true }).isEnabled(), true);
      assert.equal(await page.getByRole("alert").count(), 0);
      for (const query of requests) {
        assert.ok(Date.parse(query.searchParams.get("from")) >= Date.UTC(2000, 0, 1));
        assert.ok(Date.parse(query.searchParams.get("to")) <= Date.UTC(2100, 0, 1));
      }
    }
    assert.ok(providerQueries.length > 0);
    for (const query of providerQueries) {
      assert.ok(Date.parse(query.searchParams.get("timeMin")) >= Date.UTC(2000, 0, 1));
      assert.ok(Date.parse(query.searchParams.get("timeMax")) <= Date.UTC(2100, 0, 1));
    }
    assert.equal(fixture.google.writes.length, 0);
    assert.deepEqual(fixture.google.denied, []);
    assert.deepEqual(fixture.upstreamFailures, []);
    console.log("PASS public month boundary in Tokyo and UTC. Built Worker/local D1; Google is mocked.");
  } finally {
    try {
      for (const context of contexts) await context.close();
    } finally {
      await fixture.close();
    }
  }
}
