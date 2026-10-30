import assert from "node:assert/strict";
import process from "node:process";
import { expect } from "@playwright/test";
import { calendarExport } from "../src/client/calendar-export.ts";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyConflictCalendarsUI(browser) {
  const fixedTime = Date.UTC(2030, 0, 1),
    hour = 3_600_000;
  const f = await createWorkerFixture({ port: 8802, fixedTime });
  let context;
  try {
    const owner = await f.login(),
      secondary = "PrivateSelection@group.calendar.google.com",
      longId = `<b>${"private".repeat(45)}</b>@group.calendar.google.com`,
      literal = `<img src="/unexpected-calendar-image" onerror="alert(1)">${"LongName".repeat(45)}`;
    f.google.calendars.push(
      { id: "organizer@example.test", summary: "Private primary", primary: true, accessRole: "owner" },
      { id: secondary, summary: "Private secondary", accessRole: "freeBusyReader", hidden: true },
      { id: longId, summary: literal, accessRole: "reader" }
    );
    const configured = {
      ...f.settings,
      schedule: {
        timeZone: "UTC",
        rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 540, endMinute: 720 })),
      },
    };
    await f.read(await f.send("/api/owner", configured, owner, "PUT"));
    const settingsBefore = await f.db.prepare("SELECT json,version FROM organizer_settings").first();
    const reads = f.google.calendarReads.length;
    const html = await f.request("/", { headers: owner });
    assert.equal(html.headers.get("cache-control"), "private, no-store");
    assert.ok(!(await html.text()).includes("Private secondary"));
    assert.equal(f.google.calendarReads.length, reads, "Home SSR must not discover calendars");
    context = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
    await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
    const page = await context.newPage(),
      errors = [],
      saves = [],
      unexpected = [];
    await page.clock.install({ time: fixedTime });
    page.on("pageerror", (error) => errors.push(error.message));
    page.on("request", (request) => {
      const path = new URL(request.url()).pathname;
      if (path === "/api/owner/conflict-calendars" && request.method() === "PATCH")
        saves.push(request.postDataJSON());
      if (path === "/unexpected-calendar-image") unexpected.push(path);
    });
    await page.route(
      "**/api/owner/conflict-calendars",
      (route) =>
        route.fulfill({
          status: 503,
          contentType: "application/json",
          body: JSON.stringify({ error: "calendar_unavailable" }),
        }),
      { times: 1 }
    );
    await page.goto(f.origin);
    const form = page.getByRole("form", { name: "Conflict calendars", exact: true });
    const primary = form.getByRole("checkbox", { name: "Private primary", exact: true }),
      secondaryBox = form.getByRole("checkbox", { name: "Private secondary", exact: true }),
      save = form.getByRole("button", { name: "Save", exact: true }),
      reset = form.getByRole("button", { name: "Reset to primary", exact: true }),
      retry = form.getByRole("button", { name: "Reload calendars", exact: true }),
      clear = form.getByRole("button", { name: "Clear selection", exact: true });
    const saved = async (button = save) => {
      const response = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/owner/conflict-calendars" &&
          response.request().method() === "PATCH"
      );
      await button.click();
      assert.equal((await response).status(), 200);
      await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    };
    const stored = async () => (await f.read(await f.request("/api/owner", { headers: owner }))).settings;
    await form.getByRole("alert").filter({ hasText: "couldn't load" }).waitFor();
    await expect(form.getByRole("link", { name: "Reconnect Google" })).toHaveAttribute(
      "href",
      "/api/auth/login"
    );
    await expect(page.getByRole("textbox", { name: "Title", exact: true })).toBeEnabled();
    await expect(save).toBeDisabled();
    assert.equal(saves.length, 0);
    await retry.click();
    await expect(primary).toBeEnabled();
    await expect(primary).toBeChecked();
    await expect(secondaryBox).not.toBeChecked();
    assert.deepEqual(
      await f.db.prepare("SELECT json,version FROM organizer_settings").first(),
      settingsBefore
    );
    assert.equal(await f.db.prepare("SELECT count(*) AS n FROM booking_command").first("n"), 0);
    assert.equal(f.google.writes.length, 0);
    await primary.focus();
    await page.keyboard.press("Space");
    await secondaryBox.focus();
    await page.keyboard.press("Space");
    assert.equal(saves.length, 0, "Checkbox drafts cannot save");
    await retry.click();
    await expect(primary).toBeEnabled();
    await expect(primary).not.toBeChecked();
    await expect(secondaryBox).toBeChecked();
    assert.equal(saves.length, 0, "Discovery retry cannot save or overwrite a draft");
    const longBox = form.getByRole("checkbox", { name: literal, exact: true });
    await expect(longBox).toBeVisible();
    assert.equal(await form.locator("img").count(), 0);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await form.screenshot({
        path: new URL(`../.verification/conflict-calendars-${width}.png`, import.meta.url).pathname,
        animations: "disabled",
      });
    }
    await page.route(
      "**/api/owner/conflict-calendars",
      (route) => route.fulfill({ status: 503, contentType: "application/json", body: "{}" }),
      { times: 1 }
    );
    await save.click();
    await form.getByRole("alert").filter({ hasText: "couldn't confirm" }).waitFor();
    await expect(secondaryBox).toBeChecked();
    assert.equal((await stored()).conflictCalendarIds, undefined);
    await page.route(
      "**/api/owner/conflict-calendars",
      async (route) => {
        const response = await route.fetch();
        await route.fulfill({ response, body: JSON.stringify({ saved: "true" }) });
      },
      { times: 1 }
    );
    await save.click();
    await form.getByRole("alert").filter({ hasText: "couldn't confirm" }).waitFor();
    await expect(secondaryBox).toBeChecked();
    await saved();
    assert.deepEqual(
      saves,
      Array.from({ length: 3 }, () => ({ conflictCalendarIds: [secondary] }))
    );
    assert.deepEqual((await stored()).conflictCalendarIds, [secondary]);
    await page.reload();
    await expect(secondaryBox).toBeEnabled();
    await expect(secondaryBox).toBeChecked();
    await expect(primary).not.toBeChecked();

    const start = fixedTime + 9 * hour;
    const slots = () =>
      f.request(
        `/api/slots?${new URLSearchParams({ from: new Date(start).toISOString(), to: new Date(start + hour).toISOString(), timeZone: "UTC" })}`
      );
    assert.equal((await f.read(await slots())).slots.length, 2);
    f.google.secondaryBusy.set(secondary, [
      { start: new Date(start).toISOString(), end: new Date(start + hour).toISOString() },
    ]);
    assert.deepEqual((await f.read(await slots())).slots, []);
    await f.read(
      await f.send("/api/bookings", {
        requestKey: "conflict-ui-cached-slot-0001",
        start,
        name: "Stale Guest",
        email: "stale@example.test",
        timeZone: "UTC",
      }),
      409
    );
    assert.equal(f.google.writes.length, 0);
    await saved(reset);
    assert.deepEqual(saves.at(-1), { conflictCalendarIds: null });
    assert.equal(Object.hasOwn(await stored(), "conflictCalendarIds"), false);
    await page.reload();
    await expect(primary).toBeEnabled();
    await expect(primary).toBeChecked();
    assert.equal((await f.read(await slots())).slots.length, 2);
    f.google.events.set("primary-busy", {
      id: "primary-busy",
      start: { dateTime: new Date(start).toISOString() },
      end: { dateTime: new Date(start + hour).toISOString() },
    });
    assert.deepEqual((await f.read(await slots())).slots, []);
    await clear.click();
    await saved();
    assert.deepEqual(saves.at(-1), { conflictCalendarIds: [] });
    await page.reload();
    await expect(primary).toBeEnabled();
    await expect(form.getByRole("checkbox", { checked: true })).toHaveCount(0);
    assert.equal((await f.read(await slots())).slots.length, 2);

    await secondaryBox.check();
    await longBox.check();
    await saved();
    const arbitrary = [secondary, longId].sort();
    assert.deepEqual(saves.at(-1), { conflictCalendarIds: arbitrary });
    for (const route of ["/", "/api/owner/conflict-calendars", "/api/public", "/intro"]) {
      const response = await f.request(route),
        text = await response.text();
      assert.equal(response.status, route === "/api/owner/conflict-calendars" ? 401 : 200);
      for (const privateValue of [secondary, longId, literal, "Private secondary"])
        assert.ok(!text.includes(privateValue), route);
    }
    const denied = await f.request("/", { headers: { Cookie: "flare_session=denied" } });
    assert.ok(!(await denied.text()).includes("Conflict calendars"));
    f.google.calendars.splice(2, 1);
    await page.reload();
    await expect(secondaryBox).toBeEnabled();
    const missing = form.locator("label").filter({ hasText: longId }).getByRole("checkbox");
    await expect(missing).toBeChecked();
    await expect(form.getByText("Unavailable calendar", { exact: true })).toBeVisible();
    await expect(save).toBeDisabled();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await retry.click();
    await expect(missing).toBeEnabled();
    await expect(missing).toBeChecked();
    assert.deepEqual((await stored()).conflictCalendarIds, arbitrary);
    await missing.uncheck();
    await saved();
    assert.deepEqual((await stored()).conflictCalendarIds, [secondary]);

    for (const malformed of [
      {
        calendars: [
          { id: secondary, name: "Private secondary", primary: false },
          { id: secondary, name: "Duplicate", primary: false },
        ],
        conflictCalendarIds: [secondary],
      },
      {
        calendars: [{ id: "primary", name: "Wrong primary", primary: false }],
        conflictCalendarIds: [secondary],
      },
      { calendars: [{ id: "bad id", name: "Invalid", primary: false }], conflictCalendarIds: [secondary] },
      { calendars: [], conflictCalendarIds: "invalid" },
      { unexpected: true },
    ]) {
      await page.route(
        "**/api/owner/conflict-calendars",
        (route) => route.fulfill({ contentType: "application/json", body: JSON.stringify(malformed) }),
        { times: 1 }
      );
      await retry.click();
      await form.getByRole("alert").filter({ hasText: "couldn't load" }).waitFor();
      await expect(secondaryBox).toBeChecked();
      await expect(save).toBeDisabled();
    }
    const discoveryReads = f.google.calendarReads.length;
    await clear.click();
    await saved();
    assert.deepEqual((await stored()).conflictCalendarIds, []);
    await saved(reset);
    assert.equal(Object.hasOwn(await stored(), "conflictCalendarIds"), false);
    assert.equal(f.google.calendarReads.length, discoveryReads, "Empty/reset saves do not need discovery");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    await page.route(
      "**/api/owner/conflict-calendars",
      async (route) => {
        await gate;
        await route.continue();
      },
      { times: 1 }
    );
    const reading = page.waitForRequest("**/api/owner/conflict-calendars");
    await retry.click();
    await reading;
    await expect(reset).toBeDisabled();
    await expect(clear).toBeDisabled();
    await expect(primary).toBeDisabled();
    release();
    await expect(primary).toBeEnabled();
    await expect(primary).toBeChecked();
    let finishSave;
    const saveGate = new Promise((resolve) => {
      finishSave = resolve;
    });
    await page.route(
      "**/api/owner/conflict-calendars",
      async (route) => {
        await saveGate;
        await route.continue();
      },
      { times: 1 }
    );
    const saving = page.waitForRequest("**/api/owner/conflict-calendars");
    await save.click();
    await saving;
    for (const control of [save, reset, clear, retry, primary]) await expect(control).toBeDisabled();
    finishSave();
    await form.getByRole("status").filter({ hasText: "Saved" }).waitFor();
    assert.equal(f.google.writes.length, 0);

    const guest = await browser.newContext({ viewport: { width: 390, height: 844 }, timezoneId: "UTC" });
    try {
      const publicPage = await guest.newPage();
      await publicPage.clock.install({ time: fixedTime });
      await publicPage.goto(`${f.origin}/${configured.event.slug}`);
      await publicPage.getByTestId("time").first().click();
      await publicPage.getByLabel("Your name*", { exact: true }).fill("Conflict Guest");
      await publicPage.getByLabel("Email address*", { exact: true }).fill("conflict@example.test");
      const response = publicPage.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === "/api/bookings" && response.request().method() === "POST"
      );
      await publicPage.getByRole("button", { name: "Confirm", exact: true }).click();
      const booking = await (await response).json();
      assert.equal(booking.status, "confirmed");
      await publicPage.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
      await clear.click();
      await saved();
      const held = await f.request(
        `/api/slots?${new URLSearchParams({ from: new Date(booking.start).toISOString(), to: new Date(booking.end).toISOString(), timeZone: "UTC" })}`
      );
      assert.deepEqual((await f.read(held)).slots, []);
      await f.read(
        await f.send("/api/bookings", {
          requestKey: "conflict-ui-local-hold-0001",
          start: booking.start,
          name: "Overlap",
          email: "overlap@example.test",
          timeZone: "UTC",
        }),
        409
      );
      await saved(reset);
      for (const route of [
        "/",
        "/api/owner/conflict-calendars",
        "/api/public",
        "/intro",
        `/booking/${booking.id}`,
      ]) {
        const response = await f.request(route),
          text = await response.text();
        assert.equal(response.status, route === "/api/owner/conflict-calendars" ? 401 : 200);
        for (const privateValue of [secondary, longId, literal, "Private secondary"])
          assert.ok(!text.includes(privateValue), route);
      }
      const expired = await f.request("/", { headers: { Cookie: "flare_session=expired" } });
      assert.ok(!(await expired.text()).includes("Conflict calendars"));
      assert.ok(!(await publicPage.content()).includes(secondary));
      await f.read(
        await f.send("/api/owner/conflict-calendars", { conflictCalendarIds: [secondary] }, owner, "PATCH")
      );
      await f.db.prepare("UPDATE owner_session SET expires_at = 0").run();
      const expiredOwner = await f.request("/", { headers: owner }),
        expiredHTML = await expiredOwner.text();
      assert.ok(!expiredHTML.includes("Conflict calendars") && !expiredHTML.includes(secondary));
      assert.equal((await f.request("/api/owner/conflict-calendars", { headers: owner })).status, 401);
    } finally {
      await guest.close();
    }
    assert.equal(f.google.writes.length, 1, "Only the explicit public booking writes a primary event");
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    assert.deepEqual(f.google.denied, []);
    assert.deepEqual(f.upstreamFailures, []);
    console.log(
      "PASS conflict-calendar owner default/select/save/reload/empty/reset, unavailable IDs, boundary failures and retries, literal text/keyboard/390/1280, secondary admission and local holds through public confirmation. Built Worker/D1 and actual Google adapter; Google HTTP is mocked."
    );
  } finally {
    try {
      await context?.close();
    } finally {
      await f.close();
    }
  }
}

export async function verifyConflictCalendars() {
  const now = Date.UTC(2030, 0, 1),
    hour = 3_600_000;
  const f = await createWorkerFixture({ port: 8802, fixedTime: now });
  try {
    const { google, db, read, request, send } = f;
    const owner = await f.login(),
      secondary = "PrivateSelection@group.calendar.google.com";
    google.calendars.push(
      { id: "organizer@example.test", summary: "Private primary name", accessRole: "owner", primary: true },
      { id: secondary, summary: "Private secondary name", accessRole: "freeBusyReader" }
    );
    const configured = {
      ...f.settings,
      event: { ...f.settings.event, location: "Room 東京\u0000tail\ud800" },
    };
    await read(await send("/api/owner", configured, owner, "PUT"));
    const select = async (ids) =>
      read(await send("/api/owner/conflict-calendars", { conflictCalendarIds: ids }, owner, "PATCH"));
    const slots = (start, headers = {}, route = "/api/slots") =>
      request(
        `${route}?${new URLSearchParams({ from: new Date(start).toISOString(), to: new Date(start + hour).toISOString(), timeZone: "UTC" })}`,
        { headers }
      );
    let sequence = 0;
    const input = (start) => ({
      requestKey: `conflict-worker-key-${++sequence}`,
      start,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    });
    const create = (value) => send("/api/bookings", value, { "CF-Connecting-IP": `192.0.2.${sequence}` });
    const busy = (start) => [
      { start: new Date(start).toISOString(), end: new Date(start + hour).toISOString() },
    ];
    const start = now + 9 * hour;
    await read(await send("/api/owner", { ...configured, conflictCalendarIds: [secondary] }, owner, "PUT"));
    await select([secondary]);
    google.events.set("unselected-primary", {
      id: "unselected-primary",
      start: { dateTime: busy(start)[0].start },
      end: { dateTime: busy(start)[0].end },
    });
    google.secondaryBusy.set("unselected", busy(start));
    assert.ok((await read(await slots(start))).slots.length > 0);
    google.secondaryBusy.set(secondary, busy(start));
    assert.deepEqual((await read(await slots(start))).slots, []);
    const rejected = input(start);
    await read(await create(rejected), 409);
    assert.equal(google.writes.length, 0);
    google.secondaryBusy.clear();
    const created = await read(await create(input(start)), 201),
      token = { Authorization: `Bearer ${created.manageToken}` };
    google.events.delete("unselected-primary");
    assert.ok(!JSON.stringify(calendarExport(created, now)).includes(secondary));
    const move = {
      action: "reschedule",
      version: 1,
      requestKey: "secondary-blocked-move",
      start: start + 2 * hour,
    };
    google.secondaryBusy.set(secondary, busy(move.start));
    for (const [route, headers] of [
      [`/api/bookings/${created.id}`, token],
      [`/api/owner/bookings/${created.id}`, owner],
    ]) {
      await read(await send(route, { ...move, requestKey: crypto.randomUUID() }, headers), 409);
    }
    for (const [route, headers] of [
      ["/api/slots", token],
      [`/api/owner/bookings/${created.id}/slots`, owner],
    ])
      assert.deepEqual((await read(await slots(move.start, headers, route))).slots, []);
    google.secondaryBusy.set(secondary, busy(start));
    await select(["primary", secondary]);
    const selfSlots = await request(
      `/api/slots?${new URLSearchParams({ from: new Date(start).toISOString(), to: new Date(start + hour).toISOString(), timeZone: "UTC", bookingId: created.id })}`,
      { headers: token }
    );
    assert.deepEqual((await read(selfSlots)).slots, [], "Mirrored secondary occupancy cannot be subtracted");
    await select([]);
    const reads = google.busyReads.length;
    assert.deepEqual((await read(await slots(start))).slots.map((slot) => slot.start).includes(start), false);
    await read(await create(input(start)), 409);
    assert.equal(google.busyReads.length, reads);
    await select([secondary]);
    const commands = await db.prepare("SELECT count(*) AS n FROM booking_command").first("n");
    const writes = google.writes.length;
    for (const failure of [
      403,
      429,
      "missing",
      { errors: [{ reason: "forbidden" }], busy: [] },
      { busy: [{ start: "bad", end: "bad" }] },
    ]) {
      google.busyFailures.set(secondary, failure);
      for (const response of [await slots(start + 3 * hour), await create(input(start + 3 * hour))]) {
        const error = await read(response, 503);
        assert.ok(!JSON.stringify(error).includes(secondary));
        assert.ok(!JSON.stringify(error).includes("Private"));
      }
    }
    assert.equal(await db.prepare("SELECT count(*) AS n FROM booking_command").first("n"), commands);
    assert.equal(google.writes.length, writes);
    google.busyFailures.clear();
    google.secondaryBusy.clear();
    await read(await create(rejected), 409);
    for (const mode of ["queued", "sent"]) {
      await select([secondary]);
      google.busyReads.length = 0;
      if (mode === "queued") google.busyFailures.set(secondary, { after: 2, status: 403 });
      else google.loseResponseAfter("insert");
      const value = input(start + (mode === "queued" ? 5 : 7) * hour);
      const pending = await read(await create(value), 202);
      assert.equal(pending.status, "attention");
      const row = await db
        .prepare("SELECT execution,settings_json FROM booking_command WHERE request_key=?")
        .bind(value.requestKey)
        .first();
      assert.equal(row.execution, mode);
      assert.deepEqual(JSON.parse(row.settings_json).conflictCalendarIds, [secondary]);
      await select([]);
      google.busyFailures.set(secondary, 403);
      const before = google.writes.length;
      const retry = () => send("/api/owner/retry", { id: pending.id }, owner);
      const recovery = await read(await retry(), mode === "queued" ? 202 : 200);
      assert.equal(recovery.status, mode === "queued" ? "attention" : "confirmed");
      assert.equal(google.writes.length, before);
      if (mode === "queued") {
        assert.ok(
          await db
            .prepare("SELECT count(*) AS n FROM booking_reservation WHERE booking_id=?")
            .bind(pending.id)
            .first("n")
        );
        google.busyFailures.clear();
        await read(await retry());
        assert.equal(google.writes.length, before + 1);
      }
      google.busyFailures.clear();
      const confirmed = await read(await request(`/api/owner/bookings/${pending.id}`, { headers: owner }));
      await select([secondary]);
      google.busyReads.length = 0;
      const moving = {
        action: "reschedule",
        version: confirmed.version,
        requestKey: crypto.randomUUID(),
        start: value.start + hour,
      };
      if (mode === "queued") google.busyFailures.set(secondary, { after: 2, status: 403 });
      else google.loseResponseAfter("update");
      await read(await send(`/api/owner/bookings/${pending.id}`, moving, owner), 202);
      await select([]);
      google.busyFailures.set(secondary, 403);
      const moveWrites = google.writes.length;
      if (mode === "queued") {
        for (const held of [value.start, moving.start]) {
          assert.ok(!(await read(await slots(held))).slots.some((slot) => slot.start === held));
          await read(await create(input(held)), 409);
        }
      }
      await read(await retry(), mode === "queued" ? 202 : 200);
      assert.equal(google.writes.length, moveWrites);
      google.busyFailures.clear();
      const moved = await read(await retry());
      assert.equal(moved.start, moving.start);
      assert.equal(google.writes.length, moveWrites + (mode === "queued" ? 1 : 0));
    }
    await select([secondary]);
    for (const route of [
      "/api/public",
      "/intro",
      "/api/slots?from=2030-01-02T00:00:00Z&to=2030-01-02T01:00:00Z&timeZone=UTC",
      `/api/bookings/${created.id}`,
      `/booking/${created.id}`,
    ]) {
      const response = await request(route, { headers: token }),
        text = await response.text();
      assert.equal(response.status, 200);
      assert.ok(
        !text.includes(secondary) &&
          !text.includes("Private secondary name") &&
          !text.includes("conflictCalendarIds"),
        route
      );
    }
    await select(null);
    const discoveryReads = google.calendarReads.length;
    google.calendars[0].accessRole = "invalid-grant";
    await read(await create(input(start + 20 * hour)), 201);
    assert.equal(google.calendarReads.length, discoveryReads, "Legacy default needs no CalendarList grant");
    await read(
      await send("/api/owner/conflict-calendars", { conflictCalendarIds: [secondary] }, owner, "PATCH"),
      503
    );
    assert.equal(
      (await read(await request("/api/owner", { headers: owner }))).settings.conflictCalendarIds,
      undefined
    );
    assert.deepEqual(google.denied, []);
    assert.deepEqual(f.upstreamFailures, []);
    process.stdout.write(
      "PASS built Worker/D1 selection, secondary aggregation, local holds, frozen recovery, primary writes and public SSR privacy. Google transport is mocked.\n"
    );
  } finally {
    await f.close();
  }
}
