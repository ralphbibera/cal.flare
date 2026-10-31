import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { chromium, expect } from "@playwright/test";
import { hour } from "./fixtures/api.ts";
import { createWorkerFixture } from "./verify-worker.mjs";

async function verifyEvents(browser, { schedulesOnly = false } = {}) {
  const f = await createWorkerFixture({ port: 8797 });
  try {
    const { request, send, read, google, db } = f;
    const owner = await f.login();
    await read(await send("/api/owner", f.settings, owner, "PUT"));
    const entry = await (await request("/", { headers: owner })).text();
    assert.deepEqual(
      {
        directory: (await request("/public/events")).status,
        duplicate: entry.includes("/?duplicate=default"),
        visibility: entry.includes("event-hidden"),
        remove: entry.includes("Remove event"),
      },
      { directory: 200, duplicate: true, visibility: true, remove: true },
      "Directory and saved-event lifecycle controls are available"
    );
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
    if (schedulesOnly) {
      await verifyReusableSchedules(browser, f, owner, created.id);
      return;
    }
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
    await verifyProfile(browser, f, owner, created.id, details);
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
    await verifyLifecycle(browser, f, owner, created.id, start + 24 * hour, rules);
    assert.deepEqual(f.upstreamFailures, []);
    assert.deepEqual(google.denied, []);
    process.stdout.write(
      "PASS built Worker owner create/select/duplicate, uncertain submission recovery, explicit visibility, confirmed removal, SSR directory, hidden direct booking, global occupancy, final-removal creation, historical replay and recovery at 390/1280. Google mocked; live delivery remains unverified.\n"
    );
  } finally {
    await f.close();
  }
}

async function profileContext(browser, f, owner) {
  const context = await browser.newContext({ timezoneId: "UTC" });
  await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
  return context;
}

async function verifyProfile(browser, f, owner, eventId, details) {
  const context = await profileContext(browser, f, owner);
  const visitors = await browser.newContext({ timezoneId: "UTC" });
  const original = await f.read(await f.request(`/api/events/${eventId}`));
  const writes = structuredClone(f.google.writes);
  const frozen = async () =>
    Promise.all(
      [
        "booking",
        "booking_command",
        "booking_reservation",
        "organizer_settings",
        "event_type",
        "availability_schedule",
        "owner",
        "google_connection",
      ].map((table) =>
        f.db
          .prepare(`SELECT rowid AS cursor,* FROM ${table} ORDER BY rowid`)
          .all()
          .then(({ results }) => results)
      )
    );
  const before = await frozen();
  try {
    const page = await context.newPage();
    const visitor = await visitors.newPage();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await visitor.setViewportSize({ width, height: 900 });
      await page.goto(f.origin);
      await page.getByRole("link", { name: "Profile", exact: true }).click();
      const form = page.getByRole("form", { name: "Profile", exact: true });
      const name = `${"界".repeat(95)}<x>`;
      const bio = `<script>profileLiteral</script>\n**literal** ${"文".repeat(1800)}`;
      await form.getByLabel("Public display name", { exact: true }).fill(name);
      await form.getByLabel("Bio", { exact: true }).fill(bio);
      await verifyProfileFailures(page, form, { displayName: name, bio });
      await verifyProfilePending(page, form);
      await page.reload();
      await expect(form.getByLabel("Public display name", { exact: true })).toHaveValue(name);
      await expect(form.getByLabel("Bio", { exact: true })).toHaveValue(bio);
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const metadata = await f.read(await f.request(`/api/events/${eventId}`));
      assert.deepEqual(metadata.organizer, { name });
      assert.equal(JSON.stringify(metadata).includes(bio), false);
      await visitor.goto(`${f.origin}/${details.slug}`);
      await expect(visitor.getByText(name, { exact: true })).toBeVisible();
      assert.equal(await visitor.getByText(bio, { exact: true }).count(), 0);
      assert.ok(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const ssr = await (await f.request(`/${details.slug}`)).text();
      assert.ok(ssr.includes(`${"界".repeat(95)}&lt;x&gt;`), "Public SSR uses saved escaped name");
      await visitor.goto(`${f.origin}/public/events`);
      assert.equal(await visitor.getByText(bio, { exact: true }).textContent(), bio);
      assert.equal(await visitor.locator("script").filter({ hasText: "profileLiteral" }).count(), 0);
      assert.ok(await visitor.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      const directory = await (await f.request("/public/events")).text();
      for (const secret of [
        ...Object.values(f.secrets),
        ...f.google.secrets,
        "organizer@example.test",
        details.location,
      ])
        assert.ok(!directory.includes(secret));
      await verifyProfileAbandoned(page, form, f);
    }
    assert.deepEqual(
      await frozen(),
      before,
      "Profile reads and saves leave historical and admission state untouched"
    );
    assert.deepEqual(f.google.writes, writes);
    await verifyProfileIndependence(f, owner, eventId, details);
    await page.goto(`${f.origin}/owner/profile`);
    const form = page.getByRole("form", { name: "Profile", exact: true });
    await form.getByLabel("Public display name", { exact: true }).fill("");
    await form.getByLabel("Bio", { exact: true }).fill("");
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await form.getByRole("status").waitFor();
    await page.reload();
    await expect(form.getByLabel("Public display name", { exact: true })).toHaveValue("");
    assert.deepEqual((await f.read(await f.request(`/api/events/${eventId}`))).organizer, original.organizer);
    await visitor.goto(`${f.origin}/public/events`);
    assert.equal(await visitor.getByText("New unsaved draft", { exact: true }).count(), 0);
  } finally {
    await f.read(await f.send("/api/owner/profile", { displayName: null, bio: "" }, owner, "PUT"));
    await context.close();
    await visitors.close();
  }
}

async function verifyProfileFailures(page, form, draft) {
  for (const [status, body] of [
    [503, '{"error":"fixture"}'],
    [201, '{"saved":true}'],
    [200, "broken"],
    [200, "{}"],
    [200, '{"saved":false}'],
    [200, '{"saved":true,"extra":true}'],
  ]) {
    await page.route(
      "**/api/owner/profile",
      (route) => route.fulfill({ status, contentType: "application/json", body }),
      { times: 1 }
    );
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await form.getByRole("alert").waitFor();
    await expect(form.getByLabel("Public display name", { exact: true })).toHaveValue(draft.displayName);
    await expect(form.getByLabel("Bio", { exact: true })).toHaveValue(draft.bio);
    assert.equal(await form.getByRole("status").count(), 0);
  }
}

async function verifyProfilePending(page, form) {
  const applied = Promise.withResolvers(),
    release = Promise.withResolvers(),
    finished = Promise.withResolvers();
  let puts = 0;
  const route = async (request) => {
    puts++;
    const response = await request.fetch();
    applied.resolve();
    await release.promise;
    await request.fulfill({ response });
    finished.resolve();
  };
  await page.route("**/api/owner/profile", route);
  try {
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await applied.promise;
    await form.evaluate((element) => {
      element.requestSubmit();
      element.requestSubmit();
    });
    assert.equal(puts, 1, "Only one PUT may be in flight");
    assert.equal(await form.getByLabel("Public display name", { exact: true }).isDisabled(), true);
    release.resolve();
    await form.getByRole("status").waitFor();
    await finished.promise;
  } finally {
    release.resolve();
    await page.unroute("**/api/owner/profile", route);
  }
}

async function verifyProfileAbandoned(page, form, f) {
  const applied = Promise.withResolvers(),
    release = Promise.withResolvers(),
    finished = Promise.withResolvers();
  const route = async (request) => {
    const response = await request.fetch();
    applied.resolve();
    await release.promise;
    await request.fulfill({ response }).catch(() => {});
    finished.resolve();
  };
  await page.route("**/api/owner/profile", route, { times: 1 });
  try {
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await applied.promise;
    await page.goto(`${f.origin}/owner/profile`);
    await form.getByLabel("Public display name", { exact: true }).fill("New unsaved draft");
    release.resolve();
    await finished.promise;
    await expect(form.getByLabel("Public display name", { exact: true })).toHaveValue("New unsaved draft");
    assert.equal(await form.getByRole("status").count(), 0);
  } finally {
    release.resolve();
    await page.unroute("**/api/owner/profile", route);
  }
}

async function verifyProfileIndependence(f, owner, eventId, details) {
  const saved = await f.read(await f.request("/api/owner/profile", { headers: owner }));
  await f.read(
    await f.send(
      `/api/owner/events/${eventId}`,
      { ...details, description: "Independent event edit" },
      owner,
      "PATCH"
    )
  );
  await f.read(await f.send(`/api/owner/events/${eventId}`, details, owner, "PATCH"));
  const catalog = await f.read(await f.request("/api/owner/schedules", { headers: owner }));
  const selected = catalog.schedules.find((schedule) => schedule.id === catalog.defaultScheduleId);
  await f.read(
    await f.send(
      `/api/owner/schedules/${selected.id}/weekly`,
      { timeZone: "Europe/London", rules: selected.schedule.rules },
      owner,
      "PATCH"
    )
  );
  await f.read(
    await f.send(
      `/api/owner/schedules/${selected.id}/weekly`,
      { timeZone: selected.schedule.timeZone, rules: selected.schedule.rules },
      owner,
      "PATCH"
    )
  );
  const reauthorized = await f.login();
  assert.deepEqual(await f.read(await f.request("/api/owner/profile", { headers: reauthorized })), saved);
  assert.deepEqual((await f.read(await f.request(`/api/events/${eventId}`))).organizer, {
    name: saved.displayName,
  });
}

async function verifyProfileWithoutEvents(browser, f, owner) {
  assert.deepEqual((await f.read(await f.request("/api/owner/events", { headers: owner }))).events, []);
  const context = await profileContext(browser, f, owner);
  try {
    const page = await context.newPage();
    await page.goto(f.origin);
    await page.getByRole("link", { name: "Profile", exact: true }).click();
    await page.getByLabel("Public display name", { exact: true }).fill("After final event removal");
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await page.getByRole("status").waitFor();
    await page.reload();
    await expect(page.getByLabel("Public display name", { exact: true })).toHaveValue(
      "After final event removal"
    );
  } finally {
    await context.close();
  }
}

async function verifyReusableSchedules(browser, f, owner, eventId) {
  const { request, send, read } = f;
  assert.equal(
    (await request("/owner/schedules", { headers: owner })).status,
    200,
    "Owner schedule manager exists"
  );
  const catalog = await read(await request("/api/owner/schedules", { headers: owner }));
  const original = catalog.schedules.find((s) => s.id === catalog.defaultScheduleId);
  await verifyScheduleManager(browser, f, owner, eventId, original);
  const selected = await read(
    await send(`/api/owner/schedules/${original.id}/duplicate`, { name: "Private named hours" }, owner),
    201
  );
  const path = `/api/owner/schedules/${selected.id}`;
  await read(
    await send(`${path}/weekly`, { rules: original.schedule.rules, timeZone: "Asia/Tokyo" }, owner, "PATCH")
  );
  await read(
    await send(`/api/owner/events/${eventId}/schedule`, { scheduleId: selected.id }, owner, "PATCH")
  );
  const context = await browser.newContext({ timezoneId: "UTC" });
  try {
    await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
    const page = await context.newPage();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${f.origin}/?eventId=${eventId}`);
      const weekly = page.getByRole("form", { name: "Working hours", exact: true });
      await expect(weekly.locator('select[name="timeZone"]')).toHaveValue(
        width === 390 ? "Asia/Tokyo" : "Europe/London"
      );
      assert.equal(await weekly.getAttribute("action"), `${path}/weekly`);
      await weekly.locator('select[name="timeZone"]').selectOption("Europe/London");
      await page.route(
        `**${path}/weekly`,
        (route) => route.fulfill({ status: 503, json: { error: "fixture" } }),
        { times: 1 }
      );
      await weekly.getByRole("button", { name: "Save", exact: true }).click();
      await weekly.getByRole("alert").waitFor();
      await expect(weekly.locator('select[name="timeZone"]')).toHaveValue("Europe/London");
      await weekly.getByRole("button", { name: "Save", exact: true }).click();
      await weekly.getByRole("status").waitFor();
      const overrides = page.getByRole("form", { name: "Date overrides", exact: true });
      assert.equal(await overrides.getAttribute("action"), `${path}/overrides`);
      await page.route(
        `**${path}/overrides`,
        (route) => route.fulfill({ status: 503, json: { error: "fixture" } }),
        { times: 1 }
      );
      await overrides.getByRole("button", { name: "Save", exact: true }).click();
      await overrides.getByRole("alert").waitFor();
      await overrides.getByRole("button", { name: "Save", exact: true }).click();
      await overrides.getByRole("status").waitFor();
      await page.reload();
      await expect(weekly.locator('select[name="timeZone"]')).toHaveValue("Europe/London");
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const saved = await read(await request(path, { headers: owner }));
      assert.equal(saved.schedule.timeZone, "Europe/London");
      assert.deepEqual(saved.schedule.overrides, []);
      assert.deepEqual(
        (await read(await request(`/api/owner/schedules/${original.id}`, { headers: owner }))).schedule,
        original.schedule
      );
      await page.goto(`${f.origin}/?duplicate=${eventId}`);
      assert.equal(await page.getByRole("form", { name: "Event schedule", exact: true }).count(), 0);
      assert.equal(await weekly.getAttribute("action"), `${path}/weekly`);
      await page.goto(`${f.origin}/?create=1`);
      assert.equal(await page.getByRole("form", { name: "Event schedule", exact: true }).count(), 0);
      assert.equal(await weekly.getAttribute("action"), `/api/owner/schedules/${original.id}/weekly`);
    }
    const publicData = JSON.stringify(await read(await request(`/api/events/${eventId}`)));
    assert.ok(!publicData.includes(selected.id) && !publicData.includes(selected.name));
    const start = Math.ceil((Date.now() + 24 * hour) / hour) * hour;
    const booked = await read(
      await send(`/api/events/${eventId}/bookings`, {
        requestKey: randomUUID(),
        start,
        name: "Schedule guest",
        email: "schedule@example.test",
        timeZone: "UTC",
      }),
      201
    );
    assert.equal(booked.status, "confirmed");
    assert.equal(f.google.writes.filter((write) => write.id === booked.id).length, 1);
    await read(
      await send(
        `/api/bookings/${booked.id}`,
        { action: "cancel", requestKey: randomUUID(), version: booked.version },
        { Authorization: `Bearer ${booked.manageToken}` }
      )
    );
    assert.deepEqual(f.google.denied, []);
    assert.deepEqual(f.upstreamFailures, []);
    process.stdout.write(
      "PASS reusable schedule private HTTP, explicit event resolution, ID-scoped weekly/override saves with failed-save retry, reload, duplicate/create editor targets and public booking at 390/1280. Built Worker/local D1; actual Google adapter uses mocked transport.\n"
    );
  } finally {
    await context.close();
    await read(await send(`/api/owner/schedules/${selected.id}`, undefined, owner, "DELETE"));
  }
}

async function scheduleFromManager(page, f, name, source) {
  const operation = source ? "Duplicate schedule" : "Create schedule";
  const form = page.getByRole("form", { name: operation, exact: true });
  await form.getByRole("textbox").fill(name);
  assert.equal(
    await form.evaluate((form) => form.checkValidity()),
    true,
    "A valid schedule name can be submitted"
  );
  const [response] = await Promise.all([
    page.waitForResponse(
      (response) =>
        response.request().method() === "POST" &&
        response.url().endsWith(source ? `/api/owner/schedules/${source}/duplicate` : "/api/owner/schedules")
    ),
    form.getByRole("button", { name: operation, exact: true }).click(),
  ]);
  const record = await response.json();
  await expect(page.getByLabel("Select a schedule", { exact: true })).toHaveValue(record.id);
  assert.equal(record.name, name);
  assert.equal((await f.request("/owner/schedules")).status, 200);
  return record;
}

async function editManagedSchedule(page, zone, date, closed) {
  const weekly = page.getByRole("form", { name: "Working hours", exact: true });
  await weekly.locator('select[name="timeZone"]').selectOption(zone);
  for (const input of await weekly.getByLabel("Start time", { exact: true }).all()) await input.fill("09:00");
  for (const input of await weekly.getByLabel("End time", { exact: true }).all()) await input.fill("12:00");
  const weeklyPath = await weekly.getAttribute("action");
  await page.route(`**${weeklyPath}`, (route) => route.fulfill({ status: 503, json: { error: "fixture" } }), {
    times: 1,
  });
  await weekly.getByRole("button", { name: "Save", exact: true }).click();
  await weekly.getByRole("alert").waitFor();
  await expect(weekly.locator('select[name="timeZone"]')).toHaveValue(zone);
  await weekly.getByRole("button", { name: "Save", exact: true }).click();
  await weekly.getByRole("status").waitFor();
  const overrides = page.getByRole("form", { name: "Date overrides", exact: true });
  await overrides.getByRole("button", { name: "Add an override", exact: true }).click();
  await overrides.getByLabel("Date", { exact: true }).nth(0).fill(date);
  await overrides.getByRole("button", { name: "Add", exact: true }).nth(0).click();
  await overrides.getByLabel("Start time", { exact: true }).fill("09:00");
  await overrides.getByLabel("End time", { exact: true }).fill("12:00");
  await overrides.getByRole("button", { name: "Add an override", exact: true }).click();
  await overrides.getByLabel("Date", { exact: true }).nth(1).fill(closed);
  const overridePath = await overrides.getAttribute("action");
  await page.route(
    `**${overridePath}`,
    (route) => route.fulfill({ status: 200, json: { saved: true, unexpected: true } }),
    { times: 1 }
  );
  await overrides.getByRole("button", { name: "Save", exact: true }).click();
  await overrides.getByRole("alert").waitFor();
  await expect(overrides.getByLabel("Date", { exact: true }).nth(1)).toHaveValue(closed);
  await overrides.getByRole("button", { name: "Save", exact: true }).click();
  await overrides.getByRole("status").waitFor();
}

async function assignFromOwner(page, f, eventId, scheduleId, fail = false) {
  await page.goto(`${f.origin}/?eventId=${eventId}`);
  const form = page.getByRole("form", { name: "Event schedule", exact: true });
  const select = form.getByLabel("Event schedule", { exact: true });
  await select.selectOption(scheduleId ?? "");
  if (fail) {
    await page.route(
      `**/api/owner/events/${eventId}/schedule`,
      (route) => route.fulfill({ status: fail, json: { error: "unauthorized" } }),
      { times: 1 }
    );
    await form.getByRole("button", { name: "Save", exact: true }).click();
    await form.getByRole("alert").waitFor();
    await expect(select).toHaveValue(scheduleId ?? "");
  }
  await Promise.all([
    page.waitForEvent("load"),
    form.getByRole("button", { name: "Save", exact: true }).click(),
  ]);
  await expect(select).toHaveValue(scheduleId ?? "");
}

async function verifyScheduleDrafts(page, f, owner, source) {
  const rename = page.getByRole("form", { name: "Rename schedule", exact: true });
  const literal = `東京 <script>literal</script> ${"é".repeat(65)}`;
  await rename.getByRole("textbox").fill(literal);
  await page.route(
    `**/api/owner/schedules/${source.id}`,
    (route) => route.fulfill({ status: 200, json: { saved: true, unexpected: true } }),
    { times: 1 }
  );
  await rename.getByRole("button", { name: "Rename schedule", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await page.getByRole("button", { name: "Refresh schedules", exact: true }).click();
  await expect(rename.getByRole("textbox")).toHaveValue(literal);
  await page.getByRole("button", { name: "Retry", exact: true }).click();
  await expect(page.getByRole("heading", { name: `${literal} (${source.id})`, exact: true })).toBeVisible();
  assert.equal(
    (await f.read(await f.request(`/api/owner/schedules/${source.id}`, { headers: owner }))).name,
    literal
  );
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.screenshot({
      path: fileURLToPath(new URL(`../.verification/pr124-schedule-manager-${width}.png`, import.meta.url)),
      fullPage: true,
    });
  }
  const duplicate = page.getByRole("form", { name: "Duplicate schedule", exact: true });
  await page
    .getByRole("form", { name: "Working hours", exact: true })
    .locator('select[name="timeZone"]')
    .selectOption("Pacific/Auckland");
  await page
    .getByRole("form", { name: "Date overrides", exact: true })
    .getByLabel("Start time", { exact: true })
    .fill("11:00");
  await duplicate.getByRole("textbox").fill("Same name permitted");
  let posts = 0,
    copy;
  await page.route(`**/api/owner/schedules/${source.id}/duplicate`, async (route) => {
    posts++;
    const response = await route.fetch();
    assert.equal(response.status(), 201);
    copy = await response.json();
    await route.abort("failed");
  });
  await duplicate.evaluate((form) => {
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  });
  await page.getByRole("alert").filter({ hasText: "couldn't confirm creation" }).waitFor();
  assert.equal(posts, 1);
  await expect(duplicate.getByRole("button")).toBeDisabled();
  await page.getByRole("button", { name: "Refresh schedules", exact: true }).click();
  const candidates = page.getByRole("navigation", { name: "Select a schedule to inspect", exact: true });
  await candidates.getByRole("link", { name: `${copy.name} (${copy.id})`, exact: true }).waitFor();
  assert.equal(posts, 1);
  await expect(duplicate.getByRole("textbox")).toHaveValue(copy.name);
  await candidates.getByRole("link", { name: `${copy.name} (${copy.id})`, exact: true }).click();
  await expect(page.getByLabel("Select a schedule", { exact: true })).toHaveValue(copy.id);
  await page.unroute(`**/api/owner/schedules/${source.id}/duplicate`);
  return copy;
}

async function verifyScheduleFences(page, f, source) {
  const form = page.getByRole("form", { name: "Rename schedule", exact: true });
  await form.getByRole("textbox").fill("Retained refresh draft");
  await page.route(
    "**/api/owner/schedules",
    (route) => route.fulfill({ status: 200, json: { defaultScheduleId: source.id, schedules: [] } }),
    { times: 1 }
  );
  await page.getByRole("button", { name: "Refresh schedules", exact: true }).click();
  await page.getByRole("alert").waitFor();
  await expect(form.getByRole("textbox")).toHaveValue("Retained refresh draft");
  await expect(page.getByLabel("Select a schedule", { exact: true })).toHaveValue(source.id);
  await page.getByRole("button", { name: "Refresh schedules", exact: true }).click();
  await expect(form.getByRole("button")).toBeEnabled();
  const release = Promise.withResolvers(),
    applied = Promise.withResolvers(),
    finished = Promise.withResolvers();
  let requests = 0;
  await page.route(`**/api/owner/schedules/${source.id}`, async (route) => {
    requests++;
    const response = await route.fetch();
    applied.resolve();
    await release.promise;
    try {
      await route.fulfill({ response }).catch(() => undefined);
    } finally {
      finished.resolve();
    }
  });
  try {
    await form.evaluate((node) => {
      node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      node.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await applied.promise;
    assert.equal(requests, 1);
    await expect(page.getByLabel("Select a schedule", { exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Make owner default", exact: true })).toBeDisabled();
    await page.getByRole("link", { name: "Organizer", exact: true }).click();
  } finally {
    release.resolve();
    await finished.promise;
    await page.unroute(`**/api/owner/schedules/${source.id}`);
  }
  assert.equal(new URL(page.url()).pathname, "/");
  await page.goto(`${f.origin}/owner/schedules?scheduleId=${source.id}`);
  await expect(form.getByRole("textbox")).toHaveValue("Retained refresh draft");
}

async function verifyLostScheduleCreate(page, f) {
  const form = page.getByRole("form", { name: "Create schedule", exact: true });
  await form.getByRole("textbox").fill("Same name permitted");
  let posts = 0,
    created;
  await page.route("**/api/owner/schedules", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    posts++;
    const response = await route.fetch();
    created = await response.json();
    await route.abort("failed");
  });
  await form.getByRole("button", { name: "Create schedule", exact: true }).click();
  await page.getByRole("alert").filter({ hasText: "couldn't confirm creation" }).waitFor();
  await page.getByRole("button", { name: "Refresh schedules", exact: true }).click();
  const candidates = page.getByRole("navigation", { name: "Select a schedule to inspect", exact: true });
  await candidates.getByRole("link", { name: `${created.name} (${created.id})`, exact: true }).click();
  assert.equal(posts, 1);
  await expect(page.getByLabel("Select a schedule", { exact: true })).toHaveValue(created.id);
  await page.unroute("**/api/owner/schedules");
  return created;
}

async function deleteFromManager(page, f, id, uncertain = false) {
  await page.goto(`${f.origin}/owner/schedules?scheduleId=${id}`);
  const remove = page.getByRole("button", { name: "Delete schedule", exact: true });
  await remove.click();
  const confirm = page.getByRole("button", { name: "Permanently delete schedule", exact: true });
  await expect(confirm).toBeFocused();
  await page.getByRole("button", { name: "Back", exact: true }).click();
  await expect(remove).toBeFocused();
  await remove.press("Enter");
  if (uncertain)
    await page.route(
      `**/api/owner/schedules/${id}`,
      async (route) => {
        assert.equal(route.request().method(), "DELETE");
        const response = await route.fetch();
        assert.equal(response.status(), 200);
        await route.abort("failed");
      },
      { times: 1 }
    );
  await confirm.click();
  if (uncertain) {
    await page.getByRole("alert").waitFor();
    await page.getByRole("button", { name: "Refresh schedules", exact: true }).click();
    await expect(page.getByLabel("Select a schedule", { exact: true })).toHaveValue(id);
    await page.getByRole("button", { name: "Retry", exact: true }).click();
  }
  await expect(page.getByLabel("Select a schedule", { exact: true })).not.toHaveValue(id);
}

async function verifyAssignedSchedules(page, f, owner, eventId, a, b, date) {
  await page.setViewportSize({ width: 390, height: 900 });
  await assignFromOwner(page, f, "default", a.id, 401);
  await page.setViewportSize({ width: 1280, height: 900 });
  await assignFromOwner(page, f, eventId, b.id, 404);
  await expect(
    page.getByRole("link", { name: "Manage this event's resolved schedule", exact: true })
  ).toHaveAttribute("href", `/owner/schedules?scheduleId=${b.id}`);
  const slots = async (id) =>
    (
      await f.read(
        await f.request(
          `/api/events/${id}/slots?${new URLSearchParams({ from: `${date}T00:00:00.000Z`, to: `${date}T23:59:59.000Z`, timeZone: "UTC" })}`
        )
      )
    ).slots;
  const slotsA = await slots("default"),
    slotsB = await slots(eventId);
  assert.equal(slotsA[0].start, Date.parse(`${date}T00:00:00Z`));
  assert.ok(slotsB[0].start >= Date.parse(`${date}T13:00:00Z`));
  const closed = new Date(Date.parse(`${date}T00:00:00Z`) + 24 * hour).toISOString().slice(0, 10);
  const closedQuery = new URLSearchParams({
    from: `${closed}T14:00:00.000Z`,
    to: `${closed}T15:00:00.000Z`,
    timeZone: "UTC",
  });
  assert.deepEqual(
    (await f.read(await f.request(`/api/events/${eventId}/slots?${closedQuery}`))).slots,
    [],
    "A dated closure replaces weekly hours"
  );
  await page.goto(`${f.origin}/owner/schedules?scheduleId=${b.id}`);
  await page.getByRole("button", { name: "Make owner default", exact: true }).click();
  await expect(page.getByLabel("Select a schedule", { exact: true })).toBeEnabled();
  await expect(page.getByRole("button", { name: "Make owner default", exact: true })).toBeDisabled();
  assert.deepEqual(await slots("default"), slotsA, "Explicit A is unchanged by the default pointer");
  await assignFromOwner(page, f, "default", null);
  assert.equal((await slots("default"))[0].start, slotsB[0].start);
  await page.goto(`${f.origin}/owner/schedules?scheduleId=${b.id}`);
  const overrides = page.getByRole("form", { name: "Date overrides", exact: true });
  await overrides.getByLabel("Start time", { exact: true }).fill("10:00");
  await overrides.getByRole("button", { name: "Save", exact: true }).click();
  await overrides.getByRole("status").waitFor();
  const changed = await slots(eventId);
  assert.equal(changed[0].start, slotsB[0].start + hour);
  assert.equal(
    (await slots("default"))[0].start,
    changed[0].start,
    "Shared edits reach explicit and fallback events"
  );
  const stale = await f.send(`/api/events/${eventId}/bookings`, {
    requestKey: randomUUID(),
    start: slotsB[0].start,
    name: "Stale guest",
    email: "stale@example.test",
    timeZone: "UTC",
  });
  assert.equal(stale.status, 409);
  const month = new Date(`${date}T00:00:00Z`);
  month.setUTCDate(1);
  await page.clock.install({ time: month });
  await page.setViewportSize({ width: 390, height: 900 });
  await page.goto(`${f.origin}/second-event`);
  await page
    .getByTestId("day")
    .filter({ hasText: new RegExp(`^${new Date(`${date}T00:00:00Z`).getUTCDate()}(Today)?$`) })
    .click();
  await page.locator(`button[data-time="${new Date(changed[0].start).toISOString()}"]`).click();
  await page.getByLabel("Your name*", { exact: true }).fill("Reusable schedule guest");
  await page.getByLabel("Email address*", { exact: true }).fill("schedules@example.test");
  await page.getByRole("button", { name: "Confirm", exact: true }).click();
  await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
  const write = f.google.writes.at(-1);
  assert.equal(f.google.writes.filter(({ id }) => id === write.id).length, 1);
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`${f.origin}/owner/schedules?scheduleId=${a.id}`);
  const aHours = page.getByRole("form", { name: "Working hours", exact: true });
  await aHours.locator('select[name="timeZone"]').selectOption("America/New_York");
  await aHours.getByRole("button", { name: "Save", exact: true }).click();
  await aHours.getByRole("status").waitFor();
  await assignFromOwner(page, f, "default", a.id);
  await f.read(await f.send("/api/owner/conflict-calendars", { conflictCalendarIds: [] }, owner, "PATCH"));
  const availableA = await slots("default");
  assert.ok(availableA.some(({ start }) => start < changed[0].start));
  assert.ok(
    !availableA.some(({ start }) => start === changed[0].start),
    "Global reservations block overlap across distinct schedules without Google busy checks"
  );
  const conflict = await f.send("/api/events/default/bookings", {
    requestKey: randomUUID(),
    start: changed[0].start,
    name: "Overlap",
    email: "overlap@example.test",
    timeZone: "UTC",
  });
  assert.equal(conflict.status, 409);
  await f.read(await f.send("/api/owner/conflict-calendars", { conflictCalendarIds: null }, owner, "PATCH"));
  return write.id;
}

async function verifyScheduleRefreshRecovery(page, f, owner, source) {
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(`${f.origin}/owner/schedules?scheduleId=${source.id}`);
    const form = page.getByRole("form", { name: "Create schedule", exact: true });
    const name = `Acknowledged create ${width}`;
    await form.getByRole("textbox").fill(name);
    let posts = 0,
      reads = 0,
      created;
    await page.route("**/api/owner/schedules", async (route) => {
      if (route.request().method() === "POST") {
        posts++;
        const response = await route.fetch();
        assert.equal(response.status(), 201);
        created = await response.json();
        return route.fulfill({ response });
      }
      reads++;
      if (reads === 1) return route.fulfill({ status: 503, json: { error: "fixture" } });
      return route.continue();
    });
    try {
      await form.getByRole("button").click();
      await page.getByRole("alert").waitFor();
      const refresh = page.getByRole("button", { name: "Refresh schedules", exact: true });
      await expect(refresh).toBeEnabled({ timeout: 5000 });
      await expect(form.getByRole("textbox")).toHaveValue(name);
      await expect(form.getByRole("button")).toBeDisabled();
      await refresh.click();
      await expect(page.getByLabel("Select a schedule", { exact: true })).toHaveValue(created.id);
      assert.equal(posts, 1);
      assert.equal(reads, 2);
    } finally {
      await page.unroute("**/api/owner/schedules");
      if (created)
        await f.read(await f.send(`/api/owner/schedules/${created.id}`, undefined, owner, "DELETE"));
    }
  }
  await page.goto(`${f.origin}/owner/schedules?scheduleId=${source.id}`);
}

async function verifyExistingScheduleResponse(page, f, owner, source, existing) {
  const before = await f.read(await f.request("/api/owner/schedules", { headers: owner }));
  for (const width of [390, 1280]) {
    await page.setViewportSize({ width, height: 900 });
    for (const action of ["create", "duplicate"]) {
      await page.goto(`${f.origin}/owner/schedules?scheduleId=${source.id}`);
      const label = action === "create" ? "Create schedule" : "Duplicate schedule";
      const form = page.getByRole("form", { name: label, exact: true });
      const name = `Unexpected existing identity ${action}`;
      await form.getByRole("textbox").fill(name);
      const path =
        action === "create" ? "/api/owner/schedules" : `/api/owner/schedules/${source.id}/duplicate`;
      let posts = 0;
      await page.route(`**${path}`, (route) => {
        if (route.request().method() !== "POST") return route.continue();
        posts++;
        return route.fulfill({ status: 201, json: { ...existing, name } });
      });
      try {
        await form.getByRole("button").click();
        await page
          .getByRole("alert")
          .filter({ hasText: "couldn't confirm creation" })
          .waitFor({ timeout: 5000 });
        await expect(page.getByLabel("Select a schedule", { exact: true })).toHaveValue(source.id);
        await expect(form.getByRole("textbox")).toHaveValue(name);
        await expect(form.getByRole("button")).toBeDisabled();
        await page.getByRole("button", { name: "Refresh schedules", exact: true }).click();
        await page.getByRole("navigation", { name: "Select a schedule to inspect", exact: true }).waitFor();
        await expect(page.getByLabel("Select a schedule", { exact: true })).toHaveValue(source.id);
        assert.equal(posts, 1);
        assert.deepEqual(await f.read(await f.request("/api/owner/schedules", { headers: owner })), before);
      } finally {
        await page.unroute(`**${path}`);
      }
    }
  }
  await page.goto(`${f.origin}/owner/schedules?scheduleId=${existing.id}`);
}

async function verifyScheduleManager(browser, f, owner, eventId, original) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: "UTC" });
  try {
    await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto(`${f.origin}/owner/schedules`);
    await expect(page.getByRole("button", { name: "Delete schedule", exact: true })).toBeDisabled();
    const date = new Date(Date.now() + 5 * 24 * hour).toISOString().slice(0, 10);
    const closed = new Date(Date.now() + 6 * 24 * hour).toISOString().slice(0, 10);
    const a = await scheduleFromManager(page, f, "Tokyo hours", undefined);
    await verifyScheduleRefreshRecovery(page, f, owner, a);
    await verifyExistingScheduleResponse(page, f, owner, original, a);
    await editManagedSchedule(page, "Asia/Tokyo", date, closed);
    await verifyScheduleFences(page, f, a);
    const copy = await verifyScheduleDrafts(page, f, owner, a);
    const savedA = await f.read(await f.request(`/api/owner/schedules/${a.id}`, { headers: owner }));
    assert.deepEqual(copy.schedule, savedA.schedule);
    const lost = await verifyLostScheduleCreate(page, f);
    const b = await scheduleFromManager(page, f, "New York hours", undefined);
    await editManagedSchedule(page, "America/New_York", date, closed);
    const bookingId = await verifyAssignedSchedules(page, f, owner, eventId, a, b, date);
    assert.deepEqual(
      (await f.read(await f.request(`/api/owner/schedules/${copy.id}`, { headers: owner }))).schedule,
      copy.schedule,
      "Copies remain independent"
    );
    await deleteFromManager(page, f, b.id, true);
    assert.equal(
      await f.db.prepare("SELECT schedule_id FROM event_type WHERE id=?").bind(eventId).first("schedule_id"),
      null
    );
    assert.equal(
      await f.db
        .prepare("SELECT default_schedule_id FROM organizer_settings WHERE id='owner'")
        .first("default_schedule_id"),
      original.id
    );
    await deleteFromManager(page, f, a.id);
    await deleteFromManager(page, f, copy.id);
    await deleteFromManager(page, f, lost.id);
    await expect(page.getByRole("button", { name: "Delete schedule", exact: true })).toBeDisabled();
    assert.equal((await f.request(`/api/owner/bookings/${bookingId}`, { headers: owner })).status, 200);
    for (const query of [
      "?scheduleId=bad",
      `?scheduleId=${randomUUID()}`,
      "?scheduleId=legacy&scheduleId=legacy",
      "?extra=1",
    ]) {
      assert.equal((await f.request(`/owner/schedules${query}`, { headers: owner })).status, 404);
      const anonymous = await f.request(`/owner/schedules${query}`);
      assert.equal(anonymous.status, 200);
      assert.ok(!(await anonymous.text()).includes(savedA.name));
    }
    await verifyManagerUnavailable(f, owner, original);
    assert.deepEqual(errors, []);
  } finally {
    await context.close();
  }
}

async function verifyManagerUnavailable(f, owner, original) {
  await f.db.prepare("UPDATE availability_schedule SET name=' padded ' WHERE id=?").bind(original.id).run();
  try {
    assert.equal((await f.request("/owner/schedules", { headers: owner })).status, 503);
    assert.equal((await f.request("/owner/schedules")).status, 200);
  } finally {
    await f.db
      .prepare("UPDATE availability_schedule SET name=? WHERE id=?")
      .bind(original.name, original.id)
      .run();
  }
  const preferences = await f.db
    .prepare("SELECT json,version,default_schedule_id FROM organizer_settings WHERE id='owner'")
    .first();
  await f.db.prepare("DELETE FROM organizer_settings").run();
  try {
    assert.equal((await f.request("/owner/schedules", { headers: owner })).status, 503);
    assert.equal((await f.request("/owner/schedules?scheduleId=invalid")).status, 200);
  } finally {
    await f.db
      .prepare("INSERT INTO organizer_settings(id,json,version,default_schedule_id) VALUES('owner',?,?,?)")
      .bind(preferences.json, preferences.version, preferences.default_schedule_id)
      .run();
  }
}

async function verifyLifecycle(browser, f, owner, sourceId, start, rules) {
  const { send, request, read, db, google } = f;
  const remove = (id) =>
    request(`/api/owner/events/${id}`, {
      method: "DELETE",
      headers: { ...owner, Origin: f.origin },
    });
  await read(await send("/api/owner/schedule", f.settings.schedule, owner, "PATCH"));
  await read(
    await send(
      `/api/owner/events/${sourceId}/booking-rules`,
      {
        ...rules,
        intervalMinutes: 15,
        beforeMinutes: 5,
        afterMinutes: 10,
        noticeMinutes: 30,
        disableCancelling: true,
        disableRescheduling: true,
        bookingWindowDays: 30,
      },
      owner,
      "PATCH"
    )
  );
  await db
    .prepare("UPDATE event_type SET json=? WHERE id='default'")
    .bind(JSON.stringify(f.settings.event))
    .run();
  await removeFromOwner(browser, f, owner, "default");
  await read(await send(`/api/owner/events/${sourceId}/visibility`, { hidden: true }, owner, "PATCH"));
  const beforeWrites = google.writes.length;
  const source = await read(await request(`/api/owner/events/${sourceId}`, { headers: owner }));
  const details = {
    slug: "hidden-copy",
    title: `Hidden <copy> ${"x".repeat(80)}`,
    description: `Copied <script>literal</script> ${"https://example.test/".repeat(40)}`,
    durationMinutes: 30,
  };
  const copy = await duplicateFromOwner(browser, f, owner, source, details);
  assert.deepEqual(copy.event, { ...source.event, ...details });
  assert.equal(copy.lifecycle, "hidden");
  await verifyDirectory(browser, f, owner, copy);
  await read(await send(`/api/owner/events/${copy.id}/visibility`, { hidden: true }, owner, "PATCH"));
  assert.equal((await read(await request(`/api/events/${copy.id}`))).event.title, details.title);
  assert.equal((await request("/hidden-copy")).status, 200);
  const query = new URLSearchParams({
    from: new Date(start).toISOString(),
    to: new Date(start + hour).toISOString(),
    timeZone: "UTC",
  });
  assert.ok((await read(await request(`/api/events/${copy.id}/slots?${query}`))).slots.length);
  assert.equal(google.writes.length, beforeWrites);
  await bookHiddenCopy(browser, f, sourceId, copy, start);
  const input = {
    requestKey: randomUUID(),
    start: start + 2 * hour,
    name: "Lifecycle guest",
    email: "guest@example.test",
    timeZone: "UTC",
  };
  google.loseResponseAfter("insert");
  const pending = await read(await send(`/api/events/${copy.id}/bookings`, input), 202);
  const command = await db
    .prepare("SELECT settings_json,desired_json,token_hash,outcome FROM booking_command WHERE booking_id=?")
    .bind(pending.id)
    .first();
  await removeFromOwner(browser, f, owner, copy.id, true);
  await read(await remove(copy.id));
  assert.equal((await request("/hidden-copy")).status, 404);
  assert.equal((await request(`/api/events/${copy.id}`)).status, 404);
  assert.equal(
    (await send(`/api/events/${copy.id}/bookings`, { ...input, requestKey: randomUUID() })).status,
    404
  );
  await db
    .prepare("UPDATE booking_command SET due=0,lease_until=0 WHERE booking_id=?")
    .bind(pending.id)
    .run();
  await f.scheduled();
  const recovered = await read(await send(`/api/events/${copy.id}/bookings`, input), 201);
  assert.equal(recovered.id, pending.id);
  assert.equal(recovered.manageToken, pending.manageToken);
  assert.equal(recovered.disableRescheduling, true);
  assert.equal(google.writes.filter((w) => w.id === pending.id).length, 1);
  assert.deepEqual(
    await db
      .prepare("SELECT settings_json,desired_json,token_hash,outcome FROM booking_command WHERE booking_id=?")
      .bind(pending.id)
      .first(),
    command
  );
  assert.equal((await request("/", { headers: owner })).status, 200);
  assert.equal((await request("/?eventId=default", { headers: owner })).status, 404);
  assert.equal((await request("/api/public")).status, 404);
  await removeFromOwner(browser, f, owner, sourceId);
  const finalPage = await request("/", { headers: owner });
  assert.equal(finalPage.status, 200);
  assert.match(await finalPage.text(), /name="title"/);
  assert.equal((await request("/?create=1", { headers: owner })).status, 200);
  assert.equal((await request("/owner/bookings", { headers: owner })).status, 200);
  assert.deepEqual((await read(await request("/api/owner/events", { headers: owner }))).events, []);
  const empty = await request("/public/events");
  assert.equal(empty.status, 200);
  assert.match(await empty.text(), /There are no listed events/);
  assert.equal(google.writes.length, beforeWrites + 2);
  await verifyProfileWithoutEvents(browser, f, owner);
  await createAfterRemoval(browser, f, owner);
}

async function fillDuplicate(page, details) {
  await page.getByLabel("Title", { exact: true }).fill(details.title);
  await page.getByLabel("Slug", { exact: true }).fill(details.slug);
  await page.getByLabel("Description", { exact: true }).fill(details.description);
  await page.getByLabel("Duration (Minutes)", { exact: true }).fill(String(details.durationMinutes));
}

async function duplicateFromOwner(browser, f, owner, source, details) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  try {
    await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
    const page = await context.newPage();
    await page.goto(`${f.origin}/?eventId=${source.id}`);
    await page.getByLabel("Title", { exact: true }).fill("Unsaved source draft");
    await page.getByRole("link", { name: "Duplicate event", exact: true }).click();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(source.event.title);
    assert.equal(await page.getByLabel("Location", { exact: true }).count(), 0);
    assert.equal(await page.locator('form[action$="/booking-rules"]').count(), 0);
    assert.equal(await page.locator('input[name="title"]').count(), 1);
    const submissions = [];
    let outcome = "collision",
      copy;
    await page.route(`**/api/owner/events/${source.id}/duplicate`, async (route) => {
      submissions.push(route.request().postDataJSON());
      if (outcome === "expired") return route.fulfill({ status: 401, json: { error: "unauthorized" } });
      const response = await route.fetch();
      if (outcome === "lost") {
        assert.equal(response.status(), 201);
        copy = await response.json();
        return route.abort("failed");
      }
      return route.fulfill({ response });
    });
    const submit = page.getByRole("button", { name: "Duplicate event", exact: true });
    await fillDuplicate(page, { ...details, slug: "api" });
    await submit.click();
    await page.getByRole("alert").waitFor();
    assert.equal(submissions.length, 0);
    await page.getByLabel("Slug", { exact: true }).fill(source.event.slug);
    await submit.click();
    await page.getByRole("alert").filter({ hasText: "Your draft is still here" }).waitFor();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(details.title);
    outcome = "expired";
    await page.getByLabel("Slug", { exact: true }).fill(details.slug);
    await submit.click();
    await expect(submit).toBeEnabled();
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue(details.description);
    outcome = "lost";
    await submit.evaluate((button) => {
      button.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      button.form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });
    await page.getByRole("alert").filter({ hasText: "Refresh your events" }).waitFor();
    assert.equal(submissions.length, 3);
    assert.deepEqual(submissions[2], details);
    await expect(submit).toBeDisabled();
    await expect(page.getByLabel("Title", { exact: true })).toHaveValue(details.title);
    await page.getByRole("button", { name: "Refresh events", exact: true }).click();
    const candidates = page.getByRole("navigation", { name: "Select an event to inspect", exact: true });
    await candidates.waitFor();
    assert.ok(new URL(page.url()).searchParams.has("duplicate"), "Refresh does not select automatically");
    assert.equal(submissions.length, 3, "Refresh cannot repeat the duplicate POST");
    await candidates.getByRole("link", { name: `${details.title} /${details.slug}`, exact: true }).click();
    await page.waitForURL(`**/?eventId=${copy.id}`);
    await expect(page.getByLabel("Location", { exact: true })).toHaveValue(source.event.location);
    await expect(page.getByLabel("Minimum notice (Minutes)", { exact: true })).toHaveValue("30");
    await expect(page.getByLabel("Hide from public directory", { exact: true })).toBeChecked();
    await f.read(
      await f.send(
        `/api/owner/events/${source.id}`,
        {
          title: source.event.title,
          slug: source.event.slug,
          description: "Source changed independently",
          durationMinutes: source.event.durationMinutes,
          location: "Changed source room",
        },
        owner,
        "PATCH"
      )
    );
    assert.deepEqual(
      (await f.read(await f.request(`/api/owner/events/${copy.id}`, { headers: owner }))).event,
      copy.event
    );
    await verifyAbandonedDuplicate(page, f, owner, source.id);
    return copy;
  } finally {
    await context.close();
  }
}

async function verifyAbandonedDuplicate(page, f, owner, sourceId) {
  const release = Promise.withResolvers(),
    applied = Promise.withResolvers(),
    finished = Promise.withResolvers();
  try {
    await page.goto(`${f.origin}/?duplicate=${sourceId}`);
    await page.getByLabel("Slug", { exact: true }).fill("abandoned-copy");
    await page.route(
      `**/api/owner/events/${sourceId}/duplicate`,
      async (route) => {
        const response = await route.fetch();
        applied.resolve(await response.json());
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
        finished.resolve();
      },
      { times: 1 }
    );
    await page.getByRole("button", { name: "Duplicate event", exact: true }).click();
    const abandoned = await applied.promise;
    await page.locator(`nav a[href="/?eventId=${sourceId}"]`).click();
    release.resolve();
    await finished.promise;
    await expect(page.getByLabel("Slug", { exact: true })).toHaveValue("renamed-second");
    assert.equal(new URL(page.url()).search, `?eventId=${sourceId}`);
    await verifyAbandonedRemoval(page, f, owner, abandoned.id, sourceId);
  } finally {
    release.resolve();
  }
}

async function verifyAbandonedRemoval(page, f, owner, id, selectedId) {
  const release = Promise.withResolvers(),
    applied = Promise.withResolvers(),
    finished = Promise.withResolvers();
  try {
    await page.goto(`${f.origin}/?eventId=${id}`);
    await page.getByRole("button", { name: "Remove event", exact: true }).click();
    await page.route(
      `**/api/owner/events/${id}`,
      async (route) => {
        if (route.request().method() !== "DELETE") return route.continue();
        const response = await route.fetch();
        applied.resolve();
        await release.promise;
        await route.fulfill({ response }).catch(() => {});
        finished.resolve();
      },
      { times: 1 }
    );
    await page.getByRole("button", { name: "Permanently remove event", exact: true }).click();
    await applied.promise;
    await page.locator(`nav a[href="/?eventId=${selectedId}"]`).click();
    release.resolve();
    await finished.promise;
    await expect(page.getByLabel("Slug", { exact: true })).toHaveValue("renamed-second");
    assert.equal(new URL(page.url()).search, `?eventId=${selectedId}`);
    assert.equal((await f.request(`/api/owner/events/${id}`, { headers: owner })).status, 404);
  } finally {
    release.resolve();
  }
}

async function verifyDirectory(browser, f, owner, copy) {
  const context = await browser.newContext();
  try {
    await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
    const page = await context.newPage();
    await page.goto(`${f.origin}/?eventId=${copy.id}`);
    const form = page.getByRole("form", { name: "Event visibility", exact: true });
    const hidden = form.getByRole("checkbox", { name: "Hide from public directory", exact: true });
    const save = form.getByRole("button", { name: "Save", exact: true });
    const row = () => f.db.prepare("SELECT json,version FROM event_type WHERE id=?").bind(copy.id).first();
    const before = await row(),
      writes = f.google.writes.length;
    await hidden.uncheck();
    await save.click();
    await form.getByRole("status").waitFor();
    await checkDirectorySSR(browser, f, copy);
    const requests = [];
    let outcome = "failed";
    await page.route(`**/api/owner/events/${copy.id}/visibility`, async (route) => {
      requests.push(route.request().postDataJSON());
      if (outcome === "failed")
        return route.fulfill({ status: 503, json: { error: "private-visibility-detail" } });
      const response = await route.fetch();
      if (outcome === "malformed")
        return route.fulfill({ status: 200, json: { saved: true, private: "untrusted" } });
      return route.fulfill({ response });
    });
    await hidden.check();
    await save.click();
    await form.getByRole("alert").waitFor();
    await expect(hidden).toBeChecked();
    assert.ok(!(await page.content()).includes("private-visibility-detail"));
    outcome = "malformed";
    await save.click();
    await expect(save).toBeEnabled();
    await form.getByRole("alert").waitFor();
    outcome = "success";
    await save.click();
    await form.getByRole("status").waitFor();
    assert.deepEqual(requests, [{ hidden: true }, { hidden: true }, { hidden: true }]);
    await page.reload();
    await expect(hidden).toBeChecked();
    const directory = await f.request("/public/events");
    assert.equal(directory.status, 200);
    assert.ok(!(await directory.text()).includes(`href="/${copy.event.slug}"`));
    assert.equal((await f.request(`/${copy.event.slug}`)).status, 200);
    assert.deepEqual(await row(), before, "Visibility changes do not write event configuration or version");
    assert.equal(f.google.writes.length, writes);
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByLabel("Title", { exact: true }).focus();
      await expect(page.getByLabel("Title", { exact: true })).toBeFocused();
      await page.keyboard.press("Tab");
      await expect(page.getByLabel("Slug", { exact: true })).toBeFocused();
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
    assert.deepEqual(
      await page.evaluate(() => ({ local: Object.keys(localStorage), session: Object.keys(sessionStorage) })),
      { local: [], session: [] }
    );
  } finally {
    await context.close();
  }
}

async function checkDirectorySSR(browser, f, copy) {
  const response = await f.request("/public/events");
  assert.equal(response.status, 200);
  assert.match(response.headers.get("cache-control"), /no-store/);
  const html = await response.text();
  assert.ok(html.includes(`href="/${copy.event.slug}"`));
  assert.ok(html.includes("&lt;script&gt;literal&lt;/script&gt;"));
  for (const privateValue of [
    ...Object.values(f.secrets),
    ...f.google.secrets,
    "organizer@example.test",
    copy.event.location,
    "bookingWindowDays",
    "conflictCalendarIds",
    "astro-island",
    "<script>literal</script>",
  ])
    assert.ok(!html.includes(privateValue), `Directory excludes private or executable values`);
  const context = await browser.newContext({ javaScriptEnabled: false });
  try {
    const page = await context.newPage();
    for (const width of [390, 1280]) {
      await page.setViewportSize({ width, height: 900 });
      await page.goto(`${f.origin}/public/events`);
      await expect(page.getByRole("link", { name: copy.event.title, exact: true })).toHaveAttribute(
        "href",
        `/${copy.event.slug}`
      );
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    }
  } finally {
    await context.close();
  }
  const raw = await f.db.prepare("SELECT json FROM event_type WHERE id=?").bind(copy.id).first("json");
  try {
    await f.db.prepare("UPDATE event_type SET json='{}' WHERE id=?").bind(copy.id).run();
    const broken = await f.request("/public/events");
    assert.equal(broken.status, 503);
    assert.match(await broken.text(), /load events/);
  } finally {
    await f.db.prepare("UPDATE event_type SET json=? WHERE id=?").bind(raw, copy.id).run();
  }
  try {
    await f.db.prepare("ALTER TABLE event_type RENAME TO unavailable_events").run();
    assert.equal((await f.request("/public/events")).status, 503);
  } finally {
    await f.db.prepare("ALTER TABLE unavailable_events RENAME TO event_type").run();
  }
}

async function bookHiddenCopy(browser, f, sourceId, copy, start) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, timezoneId: "UTC" });
  try {
    const page = await context.newPage();
    const date = new Date(start);
    date.setUTCDate(1);
    date.setUTCHours(0, 0, 0, 0);
    await page.clock.install({ time: date });
    await page.goto(`${f.origin}/${copy.event.slug}`);
    await page
      .getByTestId("day")
      .filter({ hasText: new RegExp(`^${new Date(start).getUTCDate()}(Today)?$`) })
      .click();
    await page.locator(`button[data-time="${new Date(start).toISOString()}"]`).click();
    await page.getByLabel("Your name*", { exact: true }).fill("Hidden copy guest");
    await page.getByLabel("Email address*", { exact: true }).fill("hidden@example.test");
    const before = f.google.writes.length;
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(f.google.writes.length, before + 1);
    const remote = f.google.events.get(f.google.writes.at(-1).id);
    assert.equal(remote.summary, copy.event.title);
    assert.equal(remote.location, copy.event.location);
    assert.equal(
      Date.parse(remote.end.dateTime) - Date.parse(remote.start.dateTime),
      copy.event.durationMinutes * 60_000
    );
    const conflict = await f.read(
      await f.send(`/api/events/${sourceId}/bookings`, {
        requestKey: randomUUID(),
        start,
        name: "Conflicting guest",
        email: "conflict@example.test",
        timeZone: "UTC",
      }),
      409
    );
    assert.equal(conflict.error, "conflict");
    assert.equal(f.google.writes.length, before + 1);
  } finally {
    await context.close();
  }
}

async function removeFromOwner(browser, f, owner, id, failures = false) {
  const context = await browser.newContext({ viewport: { width: 390, height: 900 } });
  try {
    await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
    const saved = await f.read(await f.request(`/api/owner/events/${id}`, { headers: owner }));
    const page = await context.newPage();
    await page.goto(`${f.origin}/?eventId=${id}`);
    const remove = page.getByRole("button", { name: "Remove event", exact: true });
    await expect(remove).toBeEnabled();
    await remove.focus();
    await page.keyboard.press("Enter");
    const group = page.getByRole("group", { name: "Permanently remove event", exact: true });
    const back = group.getByRole("button", { name: "Back", exact: true });
    await expect(back).toBeFocused();
    await expect(group).toContainText(saved.event.title);
    await page.keyboard.press("Enter");
    await expect(group).toHaveCount(0);
    await expect(remove).toBeFocused();
    const requests = [];
    let outcome = failures ? "failed" : "success";
    await page.route(`**/api/owner/events/${id}`, async (route) => {
      if (route.request().method() !== "DELETE") return route.continue();
      requests.push({ url: route.request().url(), body: route.request().postData() });
      if (outcome === "failed")
        return route.fulfill({ status: 503, json: { error: "private-removal-detail" } });
      const response = await route.fetch();
      if (outcome === "lost")
        return route.fulfill({ status: 200, json: { saved: true, private: "bad-ack" } });
      return route.fulfill({ response });
    });
    await remove.click();
    await expect(back).toBeFocused();
    const confirm = group.getByRole("button", { name: "Permanently remove event", exact: true });
    if (failures) {
      await confirm.evaluate((button) => {
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        button.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      });
      await group.getByRole("alert").waitFor();
      assert.equal(new URL(page.url()).search, `?eventId=${id}`);
      assert.ok(!(await page.content()).includes("private-removal-detail"));
      outcome = "lost";
      await confirm.click();
      await expect(confirm).toBeEnabled();
      await group.getByRole("alert").waitFor();
      await expect(group).toContainText(saved.event.title);
      assert.equal(new URL(page.url()).search, `?eventId=${id}`);
      await expect(
        page.getByRole("checkbox", { name: "Hide from public directory", exact: true })
      ).toBeDisabled();
      outcome = "success";
    }
    await confirm.focus();
    await page.keyboard.press("Enter");
    await page.waitForURL(f.origin + "/");
    assert.equal(requests.length, failures ? 3 : 1);
    assert.ok(
      requests.every(
        (request) => request.url === `${f.origin}/api/owner/events/${id}` && request.body === null
      )
    );
    assert.equal((await f.request(`/?eventId=${id}`, { headers: owner })).status, 404);
    assert.equal((await f.request(`/?duplicate=${id}`, { headers: owner })).status, 404);
    await page.getByRole("link", { name: "Bookings", exact: true }).first().click();
    await page.getByRole("link", { name: "Organizer", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Working hours", exact: true })).toBeVisible();
  } finally {
    await context.close();
  }
}

async function createAfterRemoval(browser, f, owner) {
  const context = await browser.newContext({ viewport: { width: 1280, height: 900 }, timezoneId: "UTC" });
  try {
    await context.addCookies([{ name: "flare_session", value: owner.Cookie.split("=")[1], url: f.origin }]);
    const page = await context.newPage();
    await page.goto(f.origin);
    await fillDuplicate(page, {
      title: "After final removal",
      slug: "events",
      description: "Fresh event",
      durationMinutes: 30,
    });
    await page.getByRole("button", { name: "Create event", exact: true }).click();
    await page.waitForURL("**/?eventId=*");
    const id = new URL(page.url()).searchParams.get("eventId");
    await f.read(
      await f.send(
        "/api/owner/events",
        { title: "Public slug", slug: "public", description: "Single segment", durationMinutes: 30 },
        owner
      ),
      201
    );
    for (const path of ["/events", "/public", "/public/events"])
      assert.equal((await f.request(path)).status, 200);
    const html = await (await f.request("/public/events")).text();
    assert.ok(html.includes('href="/events"') && html.includes('href="/public"'));
    const start = Math.ceil((Date.now() + 96 * hour) / hour) * hour;
    const month = new Date(start);
    month.setUTCDate(1);
    month.setUTCHours(0, 0, 0, 0);
    await page.clock.install({ time: month });
    await page.goto(`${f.origin}/public/events`);
    await page.getByRole("link", { name: "After final removal", exact: true }).click();
    await page.waitForURL(`${f.origin}/events`);
    await page
      .getByTestId("day")
      .filter({ hasText: new RegExp(`^${new Date(start).getUTCDate()}(Today)?$`) })
      .click();
    await page.locator(`button[data-time="${new Date(start).toISOString()}"]`).click();
    await page.getByLabel("Your name*", { exact: true }).fill("Directory guest");
    await page.getByLabel("Email address*", { exact: true }).fill("directory@example.test");
    const before = f.google.writes.length;
    const command = page.waitForRequest(`**/api/events/${id}/bookings`);
    await page.getByRole("button", { name: "Confirm", exact: true }).click();
    await command;
    await page.getByRole("heading", { name: "This meeting is scheduled", exact: true }).waitFor();
    assert.equal(f.google.writes.length, before + 1);
    assert.equal(f.google.events.get(f.google.writes.at(-1).id).summary, "After final removal");
  } finally {
    await context.close();
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
    const schedule = page.getByRole("form", { name: "Working hours", exact: true });
    await schedule.locator('select[name="timeZone"]').selectOption("America/New_York");
    await schedule.getByRole("button", { name: "Save", exact: true }).click();
    await schedule.getByRole("status").waitFor();
    await page.getByRole("link", { name: "Owner A <literal> /intro", exact: true }).click();
    await expect(page.getByLabel("Description", { exact: true })).toHaveValue(f.settings.event.description);
    await expect(schedule.locator('select[name="timeZone"]')).toHaveValue("America/New_York");
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
    await verifyEvents(browser, { schedulesOnly: process.argv.includes("--schedules-only") });
  } finally {
    await browser.close();
  }
}

export { verifyEvents };
