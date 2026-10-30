import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function verifyOwnerCancellation(browser, fixture) {
  const owner = await fixture.login();
  await fixture.read(await fixture.send("/api/owner", fixture.settings, owner, "PUT"));
  for (const width of [390, 1280]) {
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 4 + (width === 390 ? 0 : 1));
    start.setUTCHours(12, 0, 0, 0);
    const booking = await fixture.read(
      await fixture.send(
        "/api/bookings",
        {
          requestKey: crypto.randomUUID(),
          start: +start,
          name: "Owner private guest",
          email: `owner-cancel-${width}@example.test`,
          timeZone: "Asia/Manila",
        },
        { "CF-Connecting-IP": `192.0.2.${width === 390 ? 77 : 78}` }
      ),
      201
    );
    const path = `/owner/bookings/${booking.id}`,
      api = `/api/owner/bookings/${booking.id}`;
    await fixture.read(
      await fixture.send(
        "/api/owner",
        { title: "Changed after booking", slug: "intro", description: "", durationMinutes: 60 },
        owner,
        "PATCH"
      )
    );
    for (const headers of [
      {},
      { Authorization: `Bearer ${booking.manageToken}` },
      { Cookie: `flare_session=${"A".repeat(43)}` },
    ]) {
      const denied = await fixture.request(path, { headers });
      assert.equal(denied.headers.get("cache-control"), "private, no-store");
      assert.equal(denied.headers.get("x-robots-tag"), "noindex, nofollow, noarchive");
      assert.equal(denied.headers.get("referrer-policy"), "same-origin");
      assert.equal(denied.headers.get("x-content-type-options"), "nosniff");
      const html = await denied.text();
      for (const value of [booking.email, booking.name, booking.manageToken])
        assert.ok(!html.includes(value));
    }
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const releaseRead = Promise.withResolvers();
    try {
      await context.addCookies([
        { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
      ]);
      const page = await context.newPage(),
        bodies = [],
        errors = [];
      page.on("pageerror", (error) => errors.push(error.message));
      const storageKey = `calflare:owner:calflare:change:v1:${booking.id}`,
        attendeeKey = `calflare:change:v1:${booking.id}`;
      await page.goto(fixture.origin);
      await page.evaluate(({ key }) => sessionStorage.setItem(key, "attendee-move-preserved"), {
        key: attendeeKey,
      });
      const writes = fixture.google.writes.length;
      await page
        .getByRole("listitem")
        .filter({ hasText: booking.email })
        .getByRole("link", { name: booking.title, exact: true })
        .click();
      assert.equal(new URL(page.url()).pathname, path);
      assert.equal(
        await page.locator("time").getAttribute("datetime"),
        new Date(booking.start).toISOString()
      );
      await page.getByText("Asia/Manila", { exact: false }).waitFor();
      assert.ok(!(await page.content()).includes(booking.manageToken));
      await expect(page.getByRole("button", { name: "Reschedule", exact: true })).toBeEnabled();
      let lose = true,
        refresh = "live";
      const heldRead = Promise.withResolvers();
      await page.route(`**${api}`, async (route) => {
        if (route.request().method() === "GET") {
          if (refresh === "fail")
            return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
          if (refresh === "hold") {
            heldRead.resolve();
            await releaseRead.promise;
          }
          return route.continue();
        }
        bodies.push(route.request().postData());
        const response = await route.fetch();
        if (response.ok() && lose) {
          lose = false;
          return route.fulfill({ status: response.status(), contentType: "application/json", body: "{}" });
        }
        return route.fulfill({ response });
      });
      const cancel = page.getByRole("button", { name: "Cancel event", exact: true });
      await cancel.click();
      const reason = page.getByLabel("Reason for cancellation", { exact: false });
      assert.equal(await reason.evaluate((node) => document.activeElement === node), true);
      await reason.fill("Draft retained");
      await page.getByRole("button", { name: "Nevermind", exact: true }).click();
      await cancel.click();
      assert.equal(await reason.inputValue(), "Draft retained");
      for (const invalid of [" \n\t ", "x".repeat(1001)]) {
        await reason.fill(invalid);
        await cancel.click();
        await page.getByRole("alert").waitFor();
        assert.equal(bodies.length, 0);
      }
      await page.evaluate(({ key }) => sessionStorage.setItem(key, "corrupt"), { key: storageKey });
      await reason.fill("Valid draft");
      await cancel.click();
      await page.getByRole("alert").waitFor();
      assert.equal(bodies.length, 0);
      await page.evaluate(({ key }) => sessionStorage.removeItem(key), { key: storageKey });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      assert.equal(fixture.google.writes.length, writes);
      await cancel.click();
      const normalized = "First\n😀 <literal>".padEnd(1000, "界");
      const move = async (version, start) =>
        fixture.read(
          await fixture.send(
            `/api/bookings/${booking.id}`,
            { action: "reschedule", version, start, requestKey: crypto.randomUUID() },
            { Authorization: `Bearer ${booking.manageToken}` }
          )
        );
      const latest = await move(booking.version, booking.start + 3_600_000);
      refresh = "fail";
      await reason.fill(` \n${normalized}\t `);
      await cancel.click();
      await page.getByRole("alert").filter({ hasText: "Booking status is currently unavailable." }).waitFor();
      assert.equal(await cancel.count(), 0);
      assert.equal(bodies.length, 1);
      assert.equal(JSON.parse(bodies[0]).version, booking.version);
      assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
      assert.equal(await reason.getAttribute("readonly"), null);
      assert.equal(await reason.inputValue(), normalized);
      await reason.fill(`${normalized.slice(0, -1)}改`);
      assert.equal(await reason.inputValue(), `${normalized.slice(0, -1)}改`);
      await reason.fill(normalized);
      refresh = "hold";
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await heldRead.promise;
      assert.equal(await cancel.count(), 0);
      assert.equal(bodies.length, 1);
      releaseRead.resolve();
      await expect(page.locator("time")).toHaveAttribute("datetime", new Date(latest.start).toISOString());
      assert.ok((await page.locator("time").textContent()).includes("9:00"));
      await expect(cancel).toBeEnabled();
      assert.equal(await reason.inputValue(), normalized);
      assert.equal(bodies.length, 1);
      const rejectedKeys = bodies.splice(0).map((body) => JSON.parse(body).requestKey);
      await cancel.click();
      await page.getByRole("alert").waitFor();
      assert.equal(await reason.inputValue(), normalized);
      assert.equal(await reason.getAttribute("readonly"), "");
      const saved = await page.evaluate((key) => sessionStorage.getItem(key), storageKey);
      assert.equal(JSON.parse(saved).cancellationReason, normalized);
      assert.equal(JSON.parse(saved).version, latest.version);
      assert.ok(!rejectedKeys.includes(JSON.parse(saved).requestKey));
      await page.reload();
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      assert.equal(fixture.google.writes.length, writes + 2);
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Retry", exact: true }).click(),
      ]);
      await page.getByText(`Reason for cancellation: ${normalized}`, { exact: true }).waitFor();
      assert.deepEqual(bodies, [saved, saved]);
      assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), storageKey), null);
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), attendeeKey),
        "attendee-move-preserved"
      );
      assert.equal(fixture.google.writes.length, writes + 2);
      assert.equal(
        fixture.google.writes.slice(writes).filter((write) => write.action === "delete").length,
        1
      );
      assert.equal(
        await fixture.db
          .prepare(
            "SELECT count(*) FROM booking_command WHERE booking_id=? AND action='cancel' AND outcome='accepted'"
          )
          .bind(booking.id)
          .first("count(*)"),
        1
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.addInitScript(() =>
        Object.defineProperty(window, "sessionStorage", {
          get() {
            throw new Error("Storage denied");
          },
        })
      );
      await page.reload();
      await page.getByRole("alert").waitFor();
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      assert.equal(bodies.length, 2);
      assert.deepEqual(errors, []);
    } finally {
      releaseRead.resolve();
      for (const page of context.pages()) await page.unrouteAll({ behavior: "wait" });
      await context.close();
    }
  }
  console.log(
    "PASS owner details, private access, required reason, real stale conflict, blocked failed/pending refresh, explicit reconfirmation, fail-closed storage and exact lost-ack retry at 390/1280. Built Worker/local D1; Google mocked."
  );
}
