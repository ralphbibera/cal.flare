import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { hour } from "./fixtures/api.ts";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyEvents(browser) {
  const f = await createWorkerFixture({ port: 8797 });
  try {
    const { request, send, read, google, db } = f;
    const owner = await f.login();
    await read(await send("/api/owner", f.settings, owner, "PUT"));
    const details = {
      slug: "second-event",
      title: "Second event",
      description: "B description",
      durationMinutes: 45,
      location: "Private B room 東京",
    };
    const created = await createFromOwner(browser, f, owner, details);
    assert.match(created.id, /^[0-9a-f-]{36}$/);
    const ownerPath = `/api/owner/events/${created.id}`;
    const publicPath = `/api/events/${created.id}`;
    const rules = {
      intervalMinutes: 30,
      beforeMinutes: 0,
      afterMinutes: 0,
      noticeMinutes: 0,
      disableCancelling: false,
      disableRescheduling: false,
    };
    await read(await send(`${ownerPath}/booking-rules`, rules, owner, "PATCH"));
    assert.equal((await read(await request("/api/owner/events", { headers: owner }))).events.length, 2);
    const metadata = await read(await request(publicPath));
    assert.equal(metadata.id, created.id);
    assert.equal(metadata.event.title, "Second event");
    assert.equal(metadata.event.location, undefined);
    assert.equal(metadata.conflictCalendarIds, undefined);
    for (const secret of [
      ...Object.values(f.secrets),
      ...google.secrets,
      "Private B room",
      "organizer@example.test",
    ])
      assert.ok(!JSON.stringify(metadata).includes(secret));
    assert.equal((await request("/second-event")).status, 200, "Event B has a public slug page");
    assert.equal((await request("/intro")).status, 200);
    const start = Math.ceil((Date.now() + 24 * hour) / hour) * hour;
    const query = new URLSearchParams({
      from: new Date(start).toISOString(),
      to: new Date(start + 3 * hour).toISOString(),
      timeZone: "UTC",
    });
    const slots = (await read(await request(`${publicPath}/slots?${query}`))).slots;
    assert.equal(slots[0].start, start);
    assert.equal(slots[0].end, start + 45 * 60_000);
    await bookBothEvents(browser, f, owner, created, details, start + 12 * hour);
    const initialWrites = google.writes.length;
    const input = {
      requestKey: randomUUID(),
      start,
      name: "Historical B guest",
      email: "guest@example.test",
      timeZone: "UTC",
      notes: "Keep B notes",
      guests: ["other@example.test"],
    };
    const booked = await read(await send(`${publicPath}/bookings`, input), 201);
    assert.equal(booked.title, "Second event");
    assert.equal(booked.location, details.location);
    assert.equal(booked.end, start + 45 * 60_000);
    const remote = structuredClone(google.events.get(booked.id));
    assert.equal(remote.summary, "Second event");
    assert.equal(remote.location, details.location);
    assert.match(remote.description, /Keep B notes/);
    assert.deepEqual(remote.attendees.map((a) => a.email).sort(), [
      "guest@example.test",
      "other@example.test",
    ]);
    const beforeMismatch = (await db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results;
    assert.equal((await read(await send("/api/bookings", input), 409)).error, "idempotency_mismatch");
    assert.deepEqual(
      (await db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
      beforeMismatch
    );
    assert.equal(google.writes.length, initialWrites + 1);
    await read(await send(`${publicPath}/bookings`, input), 201);
    assert.equal(google.writes.length, initialWrites + 1);
    await read(
      await send(
        ownerPath,
        {
          ...details,
          slug: "renamed-second",
          title: "Future B",
          durationMinutes: 90,
          location: "Future room",
        },
        owner,
        "PATCH"
      )
    );
    assert.equal((await read(await request(publicPath))).event.slug, "renamed-second");
    assert.equal((await request("/second-event")).status, 404);
    assert.equal((await request("/renamed-second")).status, 200);
    await read(
      await send(
        "/api/owner",
        { ...f.settings, event: { ...f.settings.event, disableCancelling: true, disableRescheduling: true } },
        owner,
        "PUT"
      )
    );
    const auth = { Authorization: `Bearer ${booked.manageToken}` };
    const moved = await read(
      await send(
        `/api/bookings/${booked.id}`,
        { action: "reschedule", requestKey: randomUUID(), version: 1, start: start + hour },
        auth
      )
    );
    assert.equal(moved.title, "Second event");
    assert.equal(moved.end - moved.start, 45 * 60_000);
    assert.equal(moved.location, details.location);
    assert.equal(google.events.get(booked.id).summary, remote.summary);
    assert.equal(google.events.get(booked.id).description, remote.description);
    assert.equal(google.events.get(booked.id).location, remote.location);
    const ownerBooking = await read(await request(`/api/owner/bookings/${booked.id}`, { headers: owner }));
    assert.equal(ownerBooking.disableRescheduling, false);
    assert.equal(ownerBooking.title, "Second event");
    const frozenInput = { ...input, requestKey: randomUUID(), start: start + 4 * hour };
    google.loseResponseAfter("insert");
    const pending = await read(await send(`${publicPath}/bookings`, frozenInput), 202);
    assert.equal(pending.status, "attention");
    const frozen = await db
      .prepare("SELECT settings_json,desired_json FROM booking_command WHERE booking_id=?")
      .bind(pending.id)
      .first();
    await read(
      await send(
        `${ownerPath}/booking-rules`,
        { ...rules, bookingWindowDays: 1, noticeMinutes: 43200 },
        owner,
        "PATCH"
      )
    );
    await read(await send("/api/owner/schedule", { timeZone: "UTC", rules: [] }, owner, "PATCH"));
    await db.prepare("UPDATE event_type SET json='{}' WHERE id='default'").run();
    await db
      .prepare("UPDATE booking_command SET due=0,lease_until=0 WHERE booking_id=?")
      .bind(pending.id)
      .run();
    await f.scheduled();
    const recovered = await read(
      await request(`/api/bookings/${pending.id}`, {
        headers: { Authorization: `Bearer ${pending.manageToken}` },
      })
    );
    assert.equal(recovered.status, "confirmed");
    assert.equal(recovered.title, "Future B");
    assert.equal(recovered.location, "Future room");
    assert.deepEqual(
      await db
        .prepare("SELECT settings_json,desired_json FROM booking_command WHERE booking_id=?")
        .bind(pending.id)
        .first(),
      frozen
    );
    assert.equal(google.writes.filter((w) => w.id === pending.id).length, 1);
    assert.deepEqual(f.upstreamFailures, []);
    assert.deepEqual(google.denied, []);
    process.stdout.write(
      "PASS built Worker owner create/select, independent events, event-bound public bookings, stale slots, rename/reload recovery, historical moves and global recovery. Google mocked; live delivery remains unverified.\n"
    );
  } finally {
    await f.close();
  }
}

async function createFromOwner(browser, f, owner, details) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: "UTC" });
  try {
    await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${f.origin}/?eventId=default`);
    const form = page.locator('form[action="/api/owner/events/default"]');
    await page.getByLabel("Title", { exact: true }).fill("Owner A <literal>");
    await page.getByLabel("Duration (Minutes)", { exact: true }).fill("60");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await form.getByRole("status").waitFor();
    const rules = page.locator('form[action$="/booking-rules"]');
    await rules.getByLabel("Minimum notice (Minutes)", { exact: true }).fill("15");
    await rules.getByRole("button", { name: "Save", exact: true }).click();
    await rules.getByRole("status").waitFor();
    await page.getByRole("link", { name: "Create event", exact: true }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue("Intro call");
    assert.equal(await page.locator('form[action$="/booking-rules"]').count(), 0);
    assert.equal(await page.locator('form[action="/api/owner/events"]').count(), 1);
    const title = page.getByLabel("Title", { exact: true });
    await page.locator('label[for="event-title"]').click();
    assert.equal(await title.evaluate((node) => document.activeElement === node), true);
    let posts = 0;
    let failure = "collision";
    let created;
    await page.route("**/api/owner/events", async (route) => {
      if (route.request().method() !== "POST") return route.continue();
      posts++;
      if (failure === "expired") return route.fulfill({ status: 401, json: { error: "unauthorized" } });
      const response = await route.fetch();
      if (failure === "uncertain") {
        assert.equal(response.status(), 201);
        created = await response.json();
        return route.fulfill({ status: 201, json: {} });
      }
      return route.fulfill({ response });
    });
    const create = page.getByRole("button", { name: "Create event", exact: true });
    await page.getByLabel("Slug", { exact: true }).fill("api");
    await create.click();
    await page.getByRole("alert").waitFor();
    assert.equal(posts, 0);
    await title.fill(details.title);
    await page.getByLabel("Slug", { exact: true }).fill("intro");
    await create.click();
    await page.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    assert.equal(posts, 1);
    assert.equal(await title.inputValue(), details.title);
    failure = "expired";
    await page.getByLabel("Slug", { exact: true }).fill(details.slug);
    await create.click();
    await expect(create).toBeEnabled();
    assert.equal(posts, 2);
    assert.equal(await title.inputValue(), details.title);
    failure = "uncertain";
    await page.getByLabel("Description", { exact: true }).fill(details.description);
    await page.getByLabel("Location", { exact: true }).fill(details.location);
    await page.getByLabel("Duration (Minutes)", { exact: true }).fill(String(details.durationMinutes));
    await create.evaluate((button) => {
      button.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      button.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.getByRole("alert").filter({ hasText: "Refresh your events" }).waitFor();
    assert.equal(posts, 3);
    assert.equal(await title.inputValue(), details.title);
    await expect(create).toBeDisabled();
    assert.ok(created);
    await page.route("**/api/owner/events", (route) => route.fulfill({ status: 200, json: {} }), {
      times: 1,
    });
    await page.getByRole("button", { name: "Refresh events", exact: true }).click();
    await expect(page.getByRole("button", { name: "Refresh events", exact: true })).toBeEnabled();
    assert.equal(await title.inputValue(), details.title);
    await expect(create).toBeDisabled();
    assert.equal(posts, 3);
    await page.getByRole("button", { name: "Refresh events", exact: true }).click();
    const candidates = page.getByRole("navigation", { name: "Select an event to inspect", exact: true });
    await candidates.getByRole("link", { name: `${details.title} /${details.slug}`, exact: true }).click();
    await page.waitForURL(`**/?eventId=${created.id}`);
    assert.equal(posts, 3);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.reload();
      await expect(page.getByLabel("Title", { exact: true })).toHaveValue(details.title);
      await expect(page.getByLabel("Minimum notice (Minutes)", { exact: true })).toHaveValue("120");
      assert.equal(await page.locator('form[action$="/booking-rules"]').count(), 1);
      assert.equal(await page.locator('input[name="title"]').count(), 1);
      const bRules = page.locator('form[action$="/booking-rules"]');
      await bRules.getByLabel("Before event (Minutes)", { exact: true }).fill("5");
      await bRules.getByRole("button", { name: "Save", exact: true }).click();
      await bRules.getByRole("status").waitFor();
      assert.ok(
        await page.evaluate(() => {
          const ids = [...document.querySelectorAll("[id]")].map((node) => node.id);
          return new Set(ids).size === ids.length && document.documentElement.scrollWidth <= innerWidth;
        })
      );
      await page.getByRole("link", { name: "Owner A <literal> /intro", exact: true }).click();
      await expect(page.getByLabel("Duration (Minutes)", { exact: true })).toHaveValue("60");
      await expect(page.getByLabel("Minimum notice (Minutes)", { exact: true })).toHaveValue("15");
      await expect(page.getByLabel("Before event (Minutes)", { exact: true })).toHaveValue("0");
      await page.getByRole("link", { name: `${details.title} /${details.slug}`, exact: true }).click();
      await expect(page.getByLabel("Before event (Minutes)", { exact: true })).toHaveValue("5");
    }
    const bDetails = page.locator(`form[action="/api/owner/events/${created.id}"]`);
    await page.getByLabel("Description", { exact: true }).fill("Independent B <literal>");
    await bDetails.getByRole("button", { name: "Save", exact: true }).click();
    await bDetails.getByRole("status").waitFor();
    const schedule = page.locator('form[action="/api/owner/schedule"]');
    await schedule.locator('select[name="timeZone"]').selectOption("America/New_York");
    await schedule.getByRole("button", { name: "Save", exact: true }).click();
    await schedule.getByRole("status").waitFor();
    await page.getByRole("link", { name: "Owner A <literal> /intro", exact: true }).click();
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue(f.settings.event.description);
    await expect(page.locator('form[action="/api/owner/schedule"] select[name="timeZone"]')).toHaveValue(
      "America/New_York"
    );
    await f.read(await f.send("/api/owner/schedule", f.settings.schedule, owner, "PATCH"));
    await f.read(await f.send(`/api/owner/events/${created.id}`, details, owner, "PATCH"));
    const htmlA = await (await f.request("/intro")).text();
    const htmlB = await (await f.request(`/${details.slug}`)).text();
    assert.ok(htmlA.includes("Owner A &lt;literal&gt;"));
    assert.ok(!htmlA.includes("Owner A <literal>"));
    assert.ok(htmlB.includes(details.title));
    assert.ok(!htmlB.includes(details.location));
    assert.ok(!htmlB.includes("conflictCalendarIds"));
    for (const query of [
      "eventId=missing",
      "eventId=default&eventId=default",
      "eventId=default&create=1",
      `eventId=${randomUUID()}`,
    ]) {
      assert.equal((await f.request(`/?${query}`, { headers: owner })).status, 404);
      const anonymous = await f.request(`/?${query}`);
      assert.equal(anonymous.status, 200);
      assert.ok(!(await anonymous.text()).includes(details.location));
    }
    assert.deepEqual(errors, []);
    return created;
  } finally {
    await context.close();
  }
}

async function bookBothEvents(browser, f, owner, created, details, start) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: "UTC" });
  try {
    const a = await context.newPage();
    const b = await context.newPage();
    const date = new Date(start);
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
    for (const page of [a, b]) await page.clock.install({ time: date });
    const iso = new Date(start).toISOString();
    const select = async (page, instant) => {
      const day = new Date(instant).getUTCDate();
      await page
        .getByTestId("day")
        .filter({ hasText: new RegExp(`^${day}(Today)?$`) })
        .click();
      await page.locator(`button[data-time="${new Date(instant).toISOString()}"]`).click();
      await page.getByLabel("Your name*", { exact: true }).fill("Event guest <literal>");
      await page.getByLabel("Email address*", { exact: true }).fill("event-ui@example.test");
    };
    await b.addInitScript(() =>
      sessionStorage.setItem("calflare:create:v1:%2Fsecond-event", "obsolete-default-draft")
    );
    await b.goto(`${f.origin}/second-event`);
    await select(b, start);
    await a.goto(`${f.origin}/intro`);
    await select(a, start);
    const before = f.google.writes.length;
    await a.getByRole("button", { name: "Confirm", exact: true }).click();
    await a.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    const keyA = "calflare:create:v2:default";
    assert.equal(
      (await a.evaluate((key) => JSON.parse(sessionStorage.getItem(key)), keyA)).eventId,
      "default"
    );
    await b.getByRole("button", { name: "Confirm", exact: true }).click();
    await b.getByRole("alert").waitFor();
    assert.equal(f.google.writes.length, before + 1);
    await b.getByRole("button", { name: "Back", exact: true }).click();
    await select(b, start + 2 * hour);
    const bodies = [];
    const acknowledgment = Promise.withResolvers();
    await b.route(
      `**/api/events/${created.id}/bookings`,
      async (route) => {
        bodies.push(route.request().postData());
        const response = await route.fetch();
        acknowledgment.resolve({ status: response.status(), body: await response.json() });
        return route.fulfill({ status: 201, json: {} });
      },
      { times: 1 }
    );
    await b.getByRole("button", { name: "Confirm", exact: true }).click();
    const result = await acknowledgment.promise;
    assert.equal(result.status, 201, JSON.stringify({ result, bodies }));
    await b.getByRole("button", { name: "Retry", exact: true }).waitFor();
    const key = `calflare:create:v2:${created.id}`;
    const pending = await b.evaluate((key) => sessionStorage.getItem(key), key);
    assert.equal(JSON.parse(pending).eventId, created.id);
    const rename = async (slug) =>
      f.read(await f.send(`/api/owner/events/${created.id}`, { ...details, slug }, owner, "PATCH"));
    await rename("ui-b-renamed");
    assert.equal((await f.request("/second-event")).status, 404);
    await b.goto(`${f.origin}/ui-b-renamed`);
    await b.getByRole("button", { name: "Retry", exact: true }).waitFor();
    assert.equal(await b.evaluate((key) => sessionStorage.getItem(key), key), pending);
    const retry = b.waitForRequest(`**/api/events/${created.id}/bookings`);
    await b.getByRole("button", { name: "Retry", exact: true }).click();
    assert.equal((await retry).postData(), bodies[0]);
    await b.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(f.google.writes.length, before + 2);
    assert.ok(!Object.hasOwn(JSON.parse(bodies[0]), "eventId"));
    const receipt = await b.evaluate((key) => sessionStorage.getItem(key), key);
    assert.equal(JSON.parse(receipt).eventId, created.id);
    for (const width of [390, 1280]) {
      await b.setViewportSize({ width, height: 900 });
      await b.reload();
      await b.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
      assert.ok(await b.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    await rename("ui-b-receipt");
    await b.goto(`${f.origin}/ui-b-receipt`);
    await b.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(await b.evaluate((key) => sessionStorage.getItem(key), key), receipt);
    let lookups = 0;
    const receiptId = JSON.parse(receipt).access.id;
    b.on("request", (request) => {
      if (new URL(request.url()).pathname === `/api/bookings/${receiptId}`) lookups++;
    });
    await b.evaluate(
      ({ key, receipt }) =>
        sessionStorage.setItem(key, JSON.stringify({ ...JSON.parse(receipt), eventId: "default" })),
      { key, receipt }
    );
    await b.reload();
    await b
      .getByRole("alert")
      .filter({ hasText: "We couldn't restore or save this booking safely" })
      .waitFor();
    assert.equal(lookups, 0);
    assert.equal(f.google.writes.length, before + 2);
    await b.evaluate(({ key, receipt }) => sessionStorage.setItem(key, receipt), { key, receipt });
    await b.reload();
    await b.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(
      await b.evaluate(() => sessionStorage.getItem("calflare:create:v1:%2Fsecond-event")),
      "obsolete-default-draft"
    );
    assert.equal(
      (
        await f.request(
          `/api/events/${created.id}/slots?${new URLSearchParams({ from: iso, to: new Date(start + hour).toISOString(), timeZone: "UTC" })}`
        )
      ).status,
      200
    );
    await rename(details.slug);
  } finally {
    await context.close();
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  const browser = await chromium.launch({ args: ["--disable-partial-raster"] });
  try {
    await verifyEvents(browser);
  } finally {
    await browser.close();
  }
}
