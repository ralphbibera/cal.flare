import assert from "node:assert/strict";
import { expect } from "@playwright/test";

export async function verifyOwnerReschedule(browser, fixture) {
  const owner = await fixture.login();
  for (const width of [390, 1280]) {
    await fixture.read(await fixture.send("/api/owner", fixture.settings, owner, "PUT"));
    const start = new Date();
    start.setUTCDate(start.getUTCDate() + 4 + (width === 390 ? 0 : 1));
    start.setUTCHours(8, 0, 0, 0);
    const booking = await fixture.read(
      await fixture.send("/api/bookings", {
        requestKey: crypto.randomUUID(),
        start: +start,
        name: "Owner move guest",
        email: `owner-move-${width}@example.test`,
        timeZone: "Asia/Manila",
      }),
      201
    );
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: "UTC" });
    const release = Promise.withResolvers();
    try {
      await context.addCookies([
        { name: "flare_session", value: owner.Cookie.split("=")[1], url: fixture.origin },
      ]);
      await fixture.read(
        await fixture.send(
          "/api/owner",
          { title: "Later event", slug: "intro", description: "", durationMinutes: 60 },
          owner,
          "PATCH"
        )
      );
      const page = await context.newPage(),
        bodies = [],
        slots = [],
        errors = [];
      const api = `/api/owner/bookings/${booking.id}`,
        key = `calflare:owner:calflare:change:v1:${booking.id}`;
      const attendeeKey = `calflare:change:v1:${booking.id}`,
        iso = (offset) => new Date(+start + offset * 3_600_000).toISOString();
      let refresh = "live",
        lose = true;
      const held = Promise.withResolvers();
      page.on("pageerror", (error) => errors.push(error.message));
      page.on("request", (request) => {
        if (request.url().includes("/slots?")) {
          slots.push(request.url());
          assert.equal(request.headers().authorization, undefined);
        }
      });
      await page.route(`**${api}`, async (route) => {
        if (route.request().method() === "GET") {
          if (refresh === "fail")
            return route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
          if (refresh === "hold") {
            held.resolve();
            await release.promise;
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
      await page.goto(`${fixture.origin}/owner/bookings/${booking.id}`);
      await page.evaluate(({ key }) => sessionStorage.setItem(key, "attendee preserved"), {
        key: attendeeKey,
      });
      await page.evaluate(() => {
        const set = Storage.prototype.setItem;
        window.ownerStorage = { writes: 0, fail: false };
        Storage.prototype.setItem = function (key, value) {
          if (key.startsWith("calflare:owner:")) {
            window.ownerStorage.writes++;
            if (window.ownerStorage.fail) throw new Error("Storage denied");
          }
          return set.call(this, key, value);
        };
      });
      const move = page.getByRole("button", { name: "Reschedule", exact: true });
      const confirm = page.getByRole("button", { name: "Confirm", exact: true });
      const reason = page.getByRole("textbox");
      const select = (offset) => page.locator(`button[data-time="${iso(offset)}"]`);
      const writes = fixture.google.writes.length;
      const blockedId = "owner-ui-busy";
      fixture.google.events.set(blockedId, {
        id: blockedId,
        etag: '"busy"',
        start: { dateTime: iso(1) },
        end: { dateTime: iso(1.5) },
      });
      await move.focus();
      await page.keyboard.press("Enter");
      await expect(select(0)).toBeVisible();
      assert.equal((await select(2).textContent()).trim(), "6:00pm");
      assert.equal(await select(1).count(), 0);
      assert.ok(slots.every((url) => new URL(url).pathname === `${api}/slots`));
      assert.ok(slots.length > 0);
      assert.equal(fixture.google.writes.length, writes);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({
        path: new URL(`../.verification/owner-reschedule-${width}.png`, import.meta.url).pathname,
        fullPage: true,
        animations: "disabled",
      });
      await select(2).focus();
      await page.keyboard.press("Enter");
      assert.equal(await reason.evaluate((node) => document.activeElement === node), true);
      assert.equal(await reason.getAttribute("rows"), "3");
      assert.equal(await reason.getAttribute("required"), null);
      await page.getByText(`${iso(2)} / ${iso(2.5)} (UTC)`, { exact: true }).waitFor();
      await reason.fill("First");
      await page.keyboard.press("End");
      await page.keyboard.press("Enter");
      await page.keyboard.type("Second");
      assert.equal(await reason.inputValue(), "First\nSecond");
      await page.getByRole("button", { name: "Back", exact: true }).click();
      await select(2).click();
      assert.equal(await reason.inputValue(), "First\nSecond");
      await reason.fill("x".repeat(1001));
      await confirm.click();
      await page.getByRole("alert").waitFor();
      assert.ok(await reason.getAttribute("aria-describedby"));
      assert.equal(await reason.getAttribute("aria-invalid"), "true");
      assert.equal(await page.evaluate(() => window.ownerStorage.writes), 0);
      assert.equal(bodies.length, 0);
      await reason.fill("Valid");
      await page.evaluate(() => {
        window.ownerStorage.fail = true;
      });
      await confirm.click();
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      assert.equal(bodies.length, 0);
      await page.evaluate(() => {
        window.ownerStorage.fail = false;
      });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await move.click();
      await select(2).click();
      const normalized = "First\n😀 <img src=x onerror=alert(1)>".padEnd(1000, "界");
      await reason.fill(` \n${normalized}\t `);
      const latest = await fixture.read(
        await fixture.send(
          `/api/bookings/${booking.id}`,
          {
            action: "reschedule",
            requestKey: crypto.randomUUID(),
            version: booking.version,
            start: +start + 3_600_000 * 3,
          },
          { Authorization: `Bearer ${booking.manageToken}` }
        )
      );
      refresh = "fail";
      await confirm.click();
      await page.getByRole("alert").filter({ hasText: "Booking status is currently unavailable." }).waitFor();
      assert.equal(await confirm.count(), 0);
      assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), key), null);
      assert.equal(await reason.inputValue(), normalized);
      assert.equal(bodies.length, 1);
      const refused = JSON.parse(bodies[0]);
      assert.equal(refused.version, booking.version);
      refresh = "hold";
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      await held.promise;
      assert.equal(await confirm.count(), 0);
      assert.equal(bodies.length, 1);
      release.resolve();
      await expect(page.locator("time").first()).toHaveAttribute(
        "datetime",
        new Date(latest.start).toISOString()
      );
      await expect(select(4)).toBeVisible();
      assert.equal(await confirm.count(), 0);
      assert.equal(bodies.length, 1);
      await select(4).click();
      assert.equal(await reason.inputValue(), normalized);
      await confirm.click();
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      const saved = await page.evaluate((key) => sessionStorage.getItem(key), key);
      const accepted = JSON.parse(saved);
      assert.equal(accepted.version, latest.version);
      assert.notEqual(accepted.requestKey, refused.requestKey);
      assert.equal(accepted.start, +start + 4 * 3_600_000);
      assert.equal(accepted.rescheduleReason, normalized);
      assert.equal(await reason.getAttribute("readonly"), "");
      await page.evaluate(
        ({ key, saved }) =>
          sessionStorage.setItem(
            key,
            JSON.stringify({ ...JSON.parse(saved), start: JSON.parse(saved).start + 60_000 })
          ),
        { key, saved }
      );
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      assert.equal(bodies.length, 2);
      await page.evaluate(({ key, saved }) => sessionStorage.setItem(key, saved), { key, saved });
      await page.getByRole("button", { name: "Retry", exact: true }).click();
      for (const name of ["Back", "Confirm", "Cancel event", "Reschedule"])
        assert.equal(await page.getByRole("button", { name, exact: true }).count(), 0);
      assert.equal(await page.getByRole("link", { name: /calendar/i }).count(), 0);
      await page.reload();
      await page.getByRole("button", { name: "Retry", exact: true }).waitFor();
      assert.equal(await reason.inputValue(), normalized);
      await page.getByText(`${iso(4)} / ${iso(4.5)} (UTC)`, { exact: true }).waitFor();
      await Promise.all([
        page.waitForEvent("load"),
        page.getByRole("button", { name: "Retry", exact: true }).click(),
      ]);
      await page.getByText(`Reschedule reason: ${normalized}`, { exact: true }).waitFor();
      assert.deepEqual(bodies.slice(1), [saved, saved]);
      assert.equal(await page.locator('img[src="x"]').count(), 0);
      assert.equal(await page.evaluate((key) => sessionStorage.getItem(key), key), null);
      assert.equal(
        await page.evaluate((key) => sessionStorage.getItem(key), attendeeKey),
        "attendee preserved"
      );
      await move.click();
      await select(5).click();
      await reason.fill(" \n\t ");
      await Promise.all([page.waitForEvent("load"), confirm.click()]);
      assert.ok(!Object.hasOwn(JSON.parse(bodies.at(-1)), "rescheduleReason"));
      assert.equal(await page.getByText(`Reschedule reason: ${normalized}`, { exact: true }).count(), 0);
      const canonical = await fixture.read(await fixture.request(api, { headers: owner }));
      assert.equal(canonical.id, booking.id);
      assert.equal(canonical.end - canonical.start, booking.end - booking.start);
      assert.equal(canonical.start, +start + 5 * 3_600_000);
      assert.equal(fixture.google.writes.length, writes + 3);
      assert.ok(
        fixture.google.writes
          .slice(writes)
          .every((write) => write.action === "update" && write.id === booking.id)
      );
      assert.ok(!JSON.stringify(fixture.google.events.get(booking.id)).includes("Reschedule reason"));
      assert.ok(!JSON.stringify(fixture.google.events.get(booking.id)).includes("onerror"));
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      assert.deepEqual(errors, []);
      fixture.google.events.delete(blockedId);
    } finally {
      release.resolve();
      for (const page of context.pages()) await page.unrouteAll({ behavior: "wait" });
      await context.close();
    }
  }
  console.log(
    "PASS owner session calendar, stored duration, optional literal reasons, frozen exact replay, genuine stale refresh and fresh selection, fail-closed storage, namespace isolation and 390/1280 keyboard usability. Built Worker/local D1; Google mocked."
  );
}
