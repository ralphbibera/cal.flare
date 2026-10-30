import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, ErrorWithCode } from "../src/client/bookings.ts";
import { calendarExport } from "../src/client/calendar-export.ts";
import { defaultSettings } from "../src/domain/settings.ts";
import { apiFixture, hour } from "./fixtures/api.ts";

test("event transport binds metadata, slots and unchanged create bodies to the selected ID", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const calls: { path: string; body: RequestInit["body"] }[] = [];
  const client = new BookerClient((path, init) => {
    calls.push({ path, body: init.body });
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(f.ownerHeaders)) headers.set(key, value);
    headers.set("Origin", f.env.PUBLIC_ORIGIN);
    return f.request(path, { ...init, headers });
  });
  const details = { slug: "client-b", title: "Client B", description: "Literal <B>", durationMinutes: 45 };
  const created = await client.ownerCreateEvent(details);
  assert.deepEqual(created.event, { ...defaultSettings.event, ...details });
  assert.deepEqual(
    (await client.ownerEvents()).map((event) => event.id),
    ["default", created.id]
  );
  assert.deepEqual(await client.ownerEvent(created.id), created);
  await client.ownerSaveRules(created.id, {
    intervalMinutes: 30,
    beforeMinutes: 0,
    afterMinutes: 0,
    noticeMinutes: 0,
    disableCancelling: false,
    disableRescheduling: false,
  });
  await client.ownerSaveEvent(created.id, { ...details, location: "Private B" });
  const data = await client.eventData(created.id);
  assert.equal(data.id, created.id);
  assert.equal(data.event.title, details.title);
  assert.equal(data.event.location, undefined);
  const start = f.now() + 10 * hour;
  const slots = await client.slots({
    access: { kind: "event", id: created.id },
    from: start,
    to: start + hour,
    timeZone: "UTC",
  });
  assert.deepEqual(slots[0], { start, end: start + 45 * 60_000 });
  const input = {
    requestKey: crypto.randomUUID(),
    start,
    name: "B",
    email: "b@example.test",
    timeZone: "UTC",
  };
  const booking = await client.create(input, created.id);
  assert.equal(booking.title, details.title);
  assert.equal(booking.location, "Private B");
  const call = calls.find((call) => call.path === `/api/events/${created.id}/bookings`);
  assert.equal(call?.body, JSON.stringify(input));
  assert.equal(Object.hasOwn(JSON.parse(String(call?.body)), "eventId"), false);
  assert.equal((await client.create(input, created.id)).id, booking.id);
  assert.equal(f.calendar.writes.length, 1);
});

test("event and owner acknowledgments fail closed on wrong IDs, duplicates and malformed policy", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  const entry = { id, event: defaultSettings.event, lifecycle: "listed" };
  for (const value of [
    null,
    { events: [entry, entry] },
    { events: [{ ...entry, id: "wrong" }] },
    { events: [{ ...entry, event: { ...entry.event, noticeMinutes: "120" } }] },
    { events: [entry], private: true },
    { events: [{ ...entry, lifecycle: "removed" }] },
    { events: [{ ...entry, lifecycle: true }] },
    { events: [{ id, event: defaultSettings.event }] },
  ]) {
    await assert.rejects(new BookerClient(async () => Response.json(value)).ownerEvents(), ErrorWithCode);
  }
  for (const value of [
    { ...defaultSettings, id: "default", organizer: { name: "Owner" } },
    {
      ...defaultSettings,
      id,
      event: { ...defaultSettings.event, location: "private" },
      organizer: { name: "Owner" },
    },
  ]) {
    await assert.rejects(new BookerClient(async () => Response.json(value)).eventData(id), ErrorWithCode);
  }
  const details = { slug: "intro", title: "Intro call", description: "", durationMinutes: 30 };
  await assert.rejects(
    new BookerClient(async () => Response.json({ ...entry, id: "default" })).ownerEvent(id),
    ErrorWithCode
  );
  for (const value of [
    { ...entry, id: "default" },
    { ...entry, event: { ...entry.event, title: "Other" } },
    { ...entry, extra: true },
  ]) {
    await assert.rejects(
      new BookerClient(async () => Response.json(value)).ownerCreateEvent(details),
      ErrorWithCode
    );
  }
  for (const value of [null, { saved: "true" }, { saved: true, id }])
    await assert.rejects(
      new BookerClient(async () => Response.json(value)).ownerSaveEvent(id, details),
      ErrorWithCode
    );
  let requests = 0;
  const client = new BookerClient(async () => {
    requests++;
    return Response.json({});
  });
  assert.throws(() => client.eventData("invalid"), ErrorWithCode);
  assert.equal(requests, 0);
});

test("calendar prefetch crosses months through HTTP/D1 and rejects oversized ranges before Calendar work", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  let reads = 0;
  const original = fixture.calendar.busy.bind(fixture.calendar);
  fixture.calendar.busy = (...args) => {
    reads++;
    return original(...args);
  };
  const client = new BookerClient((path, init) => fixture.request(path, init));
  const from = fixture.now();
  const to = from + 63 * 24 * hour;
  const slots = await client.slots({ from, to, timeZone: "UTC" });
  assert.equal(slots.length, 18_139);
  assert.deepEqual(slots[0], { start: from, end: from + 0.5 * hour });
  assert.deepEqual(slots.at(-1), { start: to - 0.5 * hour, end: to });
  assert.equal(reads, 1);
  await assert.rejects(client.slots({ from, to: to + 1, timeZone: "UTC" }), (error: unknown) => {
    assert.ok(error instanceof ErrorWithCode);
    assert.equal(error.status, 400);
    assert.equal(error.code, "invalid_range");
    return true;
  });
  assert.equal(reads, 1);
});

test("calendar decoder accepts the full bounded minute grid and rejects an extra result", async () => {
  const from = Date.UTC(2030, 0, 1);
  const slots = Array.from({ length: 90_720 }, (_, index) => ({
    start: from + index * 60_000,
    end: from + (index + 1) * 60_000,
  }));
  const client = new BookerClient(async () => Response.json({ slots }));
  const request = { from, to: from + 63 * 24 * hour, timeZone: "UTC" };
  assert.deepEqual(await client.slots(request), slots);
  slots.push({ start: request.to, end: request.to + 60_000 });
  await assert.rejects(
    client.slots(request),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
  );
});

test("booker client completes the booking lifecycle through HTTP and migrated D1", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new BookerClient((path, init) => {
    calls.push({ path, init });
    const headers = new Headers(init.headers);
    headers.set("Origin", fixture.env.PUBLIC_ORIGIN);
    return fixture.request(path, { ...init, headers });
  });
  const data = await client.publicData();
  assert.deepEqual(data.organizer, { name: "Organizer" });
  assert.equal(data.event.slug, "intro");
  const start = fixture.now() + 10 * hour;
  assert.ok(
    (await client.slots({ from: start, to: start + 2 * hour, timeZone: "UTC" })).some(
      (slot) => slot.start === start
    )
  );
  const input = {
    requestKey: crypto.randomUUID(),
    start,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
  };
  fixture.calendar.cutAfter = "insert";
  const pending = await client.create(input);
  assert.equal(pending.status, "attention");
  assert.equal(pending.pendingAction, "create");
  const access = { id: pending.id, token: pending.manageToken };
  const confirmed = await client.retry(access);
  assert.equal(confirmed.status, "confirmed");
  assert.equal((await client.create(input)).id, confirmed.id);
  assert.equal(fixture.calendar.writes.length, 1);
  await assert.rejects(client.create({ ...input, name: "Changed" }), (error: unknown) => {
    assert.ok(error instanceof ErrorWithCode);
    assert.equal(error.code, "idempotency_mismatch");
    assert.equal(error.status, 409);
    assert.equal(error.retryable, false);
    return true;
  });
  const view = await client.view(access);
  assert.equal(view.start, start);
  assert.equal(view.manageToken, undefined);
  assert.ok(
    (await client.slots({ from: start, to: start + 2 * hour, timeZone: "UTC", access })).some(
      (slot) => slot.start === start
    )
  );
  const moved = await client.change(access, {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: view.version,
    start: start + 2 * hour,
    rescheduleReason: "Private move <literal>\r\n é 😀",
  });
  assert.equal(moved.status, "confirmed");
  assert.equal(moved.start, start + 2 * hour);
  assert.equal(moved.id, access.id);
  assert.equal(moved.rescheduleReason, "Private move <literal>\r\n é 😀");
  for (const value of Object.values(calendarExport(moved, fixture.now())))
    assert.ok(!decodeURIComponent(value).includes("Private move"));
  assert.ok(!JSON.stringify(await client.publicData()).includes("Private move"));
  assert.ok(
    !JSON.stringify(await client.slots({ from: start, to: start + 4 * hour, timeZone: "UTC" })).includes(
      "Private move"
    )
  );
  fixture.calendar.cutAfter = "delete";
  const cancelling = await client.change(access, {
    action: "cancel",
    requestKey: crypto.randomUUID(),
    version: moved.version,
  });
  assert.equal(cancelling.status, "attention");
  assert.equal((await client.retry(access)).status, "cancelled");
  assert.equal(fixture.calendar.events.size, 0);
  assert.deepEqual(
    fixture.calendar.writes.map((write) => write.action),
    ["insert", "update", "delete"]
  );
  assert.ok(
    calls.every(
      ({ path, init }) =>
        !path.includes(access.token) &&
        init.credentials === "same-origin" &&
        init.cache === "no-store" &&
        init.redirect === "error"
    )
  );
  const exclusion = calls.find(({ path }) => path.includes("bookingId="));
  assert.ok(exclusion);
  assert.equal(new Headers(exclusion.init.headers).get("Authorization"), `Bearer ${access.token}`);
  const posts = calls.filter(({ path }) => path === "/api/bookings");
  assert.equal(posts[0]?.init.body, posts[1]?.init.body);
});

test("booker client distinguishes uncertain outcomes and sanitizes failures", async () => {
  for (const status of [400, 401, 404, 408, 409, 429, 503]) {
    const client = new BookerClient(async () =>
      Response.json({ error: "failure", message: "private detail" }, { status })
    );
    await assert.rejects(client.publicData(), (error: unknown) => {
      assert.ok(error instanceof ErrorWithCode);
      assert.equal(error.status, status);
      assert.equal(error.retryable, [408, 429, 503].includes(status));
      assert.equal(error.message, "failure");
      return true;
    });
  }
  const failed = new BookerClient(async () => {
    throw new Error("private network detail");
  });
  await assert.rejects(
    failed.publicData(),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "network_error" && error.retryable
  );
  for (const value of [null, { organizer: { name: "Organizer" } }]) {
    const malformed = new BookerClient(async () => Response.json(value));
    await assert.rejects(
      malformed.publicData(),
      (error: unknown) =>
        error instanceof ErrorWithCode && error.code === "invalid_response" && error.retryable
    );
  }
});

test("booker client rejects inconsistent booking data and discards unknown fields", async () => {
  const access = { id: "a".repeat(64), token: "b".repeat(43) };
  const valid = {
    id: access.id,
    status: "confirmed",
    version: 1,
    start: Date.UTC(2030, 0, 1),
    end: Date.UTC(2030, 0, 1, 0, 30),
    name: "Guest",
    email: "guest@example.test",
    title: "Call",
    timeZone: "UTC",
  };
  const client = new BookerClient(async () => Response.json({ ...valid, credential: "private" }));
  assert.deepEqual(await client.view(access), valid);
  for (const rescheduleReason of [
    "First\r\n\n é 😀 <literal>",
    "x".repeat(1000),
    "😀".repeat(500),
    "\u0000".repeat(1000),
  ]) {
    const value = { ...valid, rescheduleReason };
    assert.deepEqual(await new BookerClient(async () => Response.json(value)).view(access), value);
  }
  for (const rescheduleReason of [
    null,
    1,
    false,
    [],
    {},
    "",
    " \n ",
    " padded ",
    "x".repeat(1001),
    `${"😀".repeat(500)}x`,
  ])
    await assert.rejects(
      new BookerClient(async () => Response.json({ ...valid, rescheduleReason })).view(access),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
    );
  for (const change of [
    { status: "cancelled" },
    { status: "pending", pendingAction: "create" },
    { status: "rescheduling", pendingAction: "reschedule" },
    { status: "cancelling", pendingAction: "cancel" },
    { status: "attention", pendingAction: "reschedule", error: "event_changed" },
  ])
    await assert.rejects(
      new BookerClient(async () => Response.json({ ...valid, ...change, rescheduleReason: "Private" })).view(
        access
      ),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
    );
  const cancelled = { ...valid, status: "cancelled" };
  for (const extra of [
    {},
    { cancellationReason: "First\r\n\n é 😀 <literal>" },
    { cancellationReason: "x".repeat(1000) },
  ]) {
    const value = { ...cancelled, ...extra };
    assert.deepEqual(await new BookerClient(async () => Response.json(value)).view(access), value);
  }
  for (const cancellationReason of [
    null,
    1,
    false,
    [],
    {},
    "",
    " \n ",
    " padded ",
    "x".repeat(1001),
    `${"😀".repeat(500)}x`,
  ]) {
    await assert.rejects(
      new BookerClient(async () => Response.json({ ...cancelled, cancellationReason })).view(access),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
    );
  }
  for (const change of [
    {},
    { status: "pending", pendingAction: "create" },
    { status: "rescheduling", pendingAction: "reschedule" },
    { status: "cancelling", pendingAction: "cancel" },
    { status: "attention", pendingAction: "cancel", error: "event_changed" },
  ]) {
    await assert.rejects(
      new BookerClient(async () =>
        Response.json({ ...valid, ...change, cancellationReason: "Private" })
      ).view(access),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
    );
  }
  for (const key of ["disableCancelling", "disableRescheduling"] as const) {
    for (const value of [true, false]) {
      const payload = { ...valid, [key]: value };
      assert.deepEqual(await new BookerClient(async () => Response.json(payload)).view(access), payload);
    }
    for (const value of [null, "false", "true", 0, 1, [], {}]) {
      const malformed = new BookerClient(async () => Response.json({ ...valid, [key]: value }));
      await assert.rejects(
        malformed.view(access),
        (error: unknown) =>
          error instanceof ErrorWithCode && error.code === "invalid_response" && error.retryable
      );
    }
  }
  for (const change of [
    { status: "unknown" },
    { pendingAction: "create" },
    { status: "pending" },
    { status: "rescheduling", pendingAction: "cancel" },
    { status: "attention", pendingAction: "create" },
    { error: "unexpected" },
    { version: -1 },
    { id: "other" },
    { end: valid.start },
    { start: -1 },
    { end: Number.MAX_SAFE_INTEGER },
    { timeZone: "invalid" },
  ]) {
    const malformed = new BookerClient(async () => Response.json({ ...valid, ...change }));
    await assert.rejects(
      malformed.view(access),
      (error: unknown) =>
        error instanceof ErrorWithCode && error.code === "invalid_response" && error.retryable
    );
  }
  const noToken = new BookerClient(async () => Response.json(valid, { status: 201 }));
  await assert.rejects(
    noToken.create({
      requestKey: crypto.randomUUID(),
      start: valid.start,
      name: valid.name,
      email: valid.email,
      timeZone: valid.timeZone,
    }),
    (error: unknown) =>
      error instanceof ErrorWithCode &&
      error.code === "invalid_response" &&
      error.status === 201 &&
      error.retryable
  );
  const badSlots = new BookerClient(async () =>
    Response.json({ slots: [{ start: valid.start, end: valid.start }] })
  );
  await assert.rejects(
    badSlots.slots({ from: valid.start, to: valid.end, timeZone: "UTC" }),
    (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
  );
  let calls = 0;
  const untouched = new BookerClient(async () => {
    calls++;
    return Response.json(valid);
  });
  assert.throws(() => untouched.view({ ...access, token: "invalid" }), ErrorWithCode);
  assert.throws(() => untouched.retry({ ...access, id: "../owner" }), ErrorWithCode);
  assert.equal(calls, 0);
});
