import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, ErrorWithCode } from "../src/client/bookings.ts";
import { calendarExport } from "../src/client/calendar-export.ts";
import { defaultSettings } from "../src/domain/settings.ts";
import { apiFixture, hour } from "./fixtures/api.ts";

test("schedule transport rejects malformed private catalogs and binds records to stable IDs", async () => {
  const id = crypto.randomUUID(),
    other = crypto.randomUUID();
  const row = { id, name: "東京 <literal>", schedule: defaultSettings.schedule };
  const catalog = { defaultScheduleId: id, schedules: [row, { ...row, id: other }] };
  assert.deepEqual(await new BookerClient(async () => Response.json(row)).ownerSchedule(id), row);
  assert.deepEqual(
    await new BookerClient(async () => Response.json(row, { status: 201 })).ownerCreateSchedule(row.name),
    row
  );
  await assert.rejects(
    new BookerClient(async () => Response.json(row)).ownerCreateSchedule(row.name),
    /invalid_response/
  );
  assert.deepEqual(await new BookerClient(async () => Response.json(catalog)).ownerSchedules(), catalog);
  for (const value of [
    null,
    [],
    { ...catalog, extra: true },
    { schedules: catalog.schedules },
    { ...catalog, defaultScheduleId: crypto.randomUUID() },
    { ...catalog, schedules: [] },
    { ...catalog, schedules: [row, row] },
    ...[
      { ...row, id: id.toUpperCase() },
      { ...row, id: "../owner" },
      { ...row, name: " padded " },
      { ...row, name: "" },
      { ...row, name: "x".repeat(101) },
      { ...row, extra: true },
      { ...row, schedule: { ...row.schedule, name: "private" } },
      { ...row, schedule: { ...row.schedule, timeZone: "invalid" } },
      { ...row, schedule: { ...row.schedule, rules: [{ weekday: 1, startMinute: 0, endMinute: 0 }] } },
      {
        ...row,
        schedule: { ...row.schedule, rules: [{ weekday: 1, startMinute: 0, endMinute: 60, extra: true }] },
      },
      { ...row, schedule: { ...row.schedule, overrides: [{ date: "2030-02-30", ranges: [] }] } },
      { ...row, schedule: { ...row.schedule, overrides: [{ date: "2030-01-01", ranges: [], extra: true }] } },
    ].map((entry) => ({ defaultScheduleId: entry.id, schedules: [entry] })),
  ])
    await assert.rejects(
      new BookerClient(async () => Response.json(value)).ownerSchedules(),
      (error: unknown) => error instanceof ErrorWithCode && error.code === "invalid_response"
    );
  await assert.rejects(
    new BookerClient(async () => Response.json({ ...row, id: other })).ownerSchedule(id),
    /invalid_response/
  );
  await assert.rejects(
    new BookerClient(async () => Response.json(row, { status: 201 })).ownerCreateSchedule(row.name, id),
    /invalid_response/
  );
  await assert.rejects(
    new BookerClient(async () =>
      Response.json({ ...row, name: "wrong" }, { status: 201 })
    ).ownerCreateSchedule(row.name),
    /invalid_response/
  );
});

test("private schedule operations use exact acknowledgments and preserve request identity", async () => {
  const calls: { path: string; init: RequestInit }[] = [];
  const id = crypto.randomUUID();
  const signal = new AbortController().signal;
  const client = new BookerClient(async (path, init) => {
    calls.push({ path, init });
    return Response.json({ saved: true });
  });
  await client.ownerRenameSchedule(id, "Same name", signal);
  await client.ownerDefaultSchedule(id, signal);
  await client.ownerAssignSchedule("default", null, signal);
  await client.ownerAssignSchedule("default", id, signal);
  await client.ownerWeeklySchedule(id, defaultSettings.schedule, signal);
  await client.ownerScheduleOverrides(id, { overrides: [] }, signal);
  await client.ownerDeleteSchedule(id, signal);
  assert.deepEqual(
    calls.map(({ path }) => path),
    [
      `/api/owner/schedules/${id}`,
      `/api/owner/schedules/${id}/default`,
      "/api/owner/events/default/schedule",
      "/api/owner/events/default/schedule",
      `/api/owner/schedules/${id}/weekly`,
      `/api/owner/schedules/${id}/overrides`,
      `/api/owner/schedules/${id}`,
    ]
  );
  assert.equal(calls[1]?.init.body, "{}");
  assert.equal(calls[2]?.init.body, '{"scheduleId":null}');
  assert.equal(calls[3]?.init.body, JSON.stringify({ scheduleId: id }));
  assert.equal(calls[6]?.init.body, undefined);
  assert.ok(
    calls.every(
      ({ init }) =>
        init.credentials === "same-origin" &&
        init.cache === "no-store" &&
        init.redirect === "error" &&
        init.signal
    )
  );
  for (const value of [{ saved: true, extra: true }, { saved: false }, {}, null, []]) {
    const malformed = new BookerClient(async () => Response.json(value));
    for (const operation of [
      () => malformed.ownerRenameSchedule(id, "Name"),
      () => malformed.ownerDefaultSchedule(id),
      () => malformed.ownerDeleteSchedule(id),
      () => malformed.ownerAssignSchedule("default", id),
      () => malformed.ownerWeeklySchedule(id, defaultSettings.schedule),
      () => malformed.ownerScheduleOverrides(id, { overrides: [] }),
    ])
      await assert.rejects(operation(), /invalid_response/);
  }
  assert.throws(() => client.ownerAssignSchedule("default", "../other"), ErrorWithCode);
  assert.throws(() => client.ownerSchedule("LEGACY"), ErrorWithCode);
  assert.equal(calls.length, 7);
});

test("owner schedule endpoints require their exact successful HTTP status", async () => {
  const id = crypto.randomUUID(),
    source = crypto.randomUUID();
  const row = { id, name: "Same name", schedule: defaultSettings.schedule };
  const operations: {
    name: string;
    value: unknown;
    status: number;
    call: (client: BookerClient) => Promise<unknown>;
  }[] = [
    {
      name: "catalog",
      value: { defaultScheduleId: id, schedules: [row] },
      status: 200,
      call: (c) => c.ownerSchedules(),
    },
    { name: "record", value: row, status: 200, call: (c) => c.ownerSchedule(id) },
    { name: "rename", value: { saved: true }, status: 200, call: (c) => c.ownerRenameSchedule(id, row.name) },
    { name: "default", value: { saved: true }, status: 200, call: (c) => c.ownerDefaultSchedule(id) },
    { name: "delete", value: { saved: true }, status: 200, call: (c) => c.ownerDeleteSchedule(id) },
    {
      name: "assignment",
      value: { saved: true },
      status: 200,
      call: (c) => c.ownerAssignSchedule("default", id),
    },
    {
      name: "weekly",
      value: { saved: true },
      status: 200,
      call: (c) => c.ownerWeeklySchedule(id, row.schedule),
    },
    {
      name: "overrides",
      value: { saved: true },
      status: 200,
      call: (c) => c.ownerScheduleOverrides(id, { overrides: [] }),
    },
    { name: "create", value: row, status: 201, call: (c) => c.ownerCreateSchedule(row.name) },
    { name: "duplicate", value: row, status: 201, call: (c) => c.ownerCreateSchedule(row.name, source) },
  ];
  for (const operation of operations)
    for (const status of [200, 201, 202, 206]) {
      const result = operation.call(new BookerClient(async () => Response.json(operation.value, { status })));
      if (status === operation.status) await result;
      else
        await assert.rejects(
          result,
          (error: unknown) =>
            error instanceof ErrorWithCode && error.code === "invalid_response" && error.status === status,
          `${operation.name} rejects ${status}`
        );
    }
});

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

test("notice rules decode optional minutes and require an exact successful save acknowledgment", async () => {
  const event = { ...defaultSettings.event, minimumRescheduleNotice: 60 };
  const entry = { id: "default", event, lifecycle: "listed" };
  assert.deepEqual(
    (await new BookerClient(async () => Response.json(entry)).ownerEvent("default")).event,
    event
  );
  for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER, null, "60"])
    await assert.rejects(
      new BookerClient(async () =>
        Response.json({ ...entry, event: { ...event, minimumRescheduleNotice: value } })
      ).ownerEvent("default"),
      /invalid_response/
    );
  const rules = {
    intervalMinutes: 30,
    beforeMinutes: 0,
    afterMinutes: 0,
    noticeMinutes: 0,
    disableCancelling: false,
    disableRescheduling: false,
    minimumRescheduleNotice: 60,
  };
  for (const [status, value] of [
    [201, { saved: true }],
    [202, { saved: true }],
    [200, {}],
    [200, { saved: true, extra: true }],
  ] as const)
    await assert.rejects(
      new BookerClient(async () => Response.json(value, { status })).ownerSaveRules("default", rules),
      /invalid_response/
    );
  await new BookerClient(async (_path, init) => {
    assert.equal(init.body, JSON.stringify(rules));
    return Response.json({ saved: true });
  }).ownerSaveRules("default", rules);
});

test("lifecycle transport copies saved state, sends explicit visibility and bodyless removal, and decodes acknowledgments strictly", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const calls: { path: string; init: RequestInit }[] = [];
  const client = new BookerClient((path, init) => {
    calls.push({ path, init });
    const headers = new Headers(init.headers);
    for (const [key, value] of Object.entries(f.ownerHeaders)) headers.set(key, value);
    headers.set("Origin", f.env.PUBLIC_ORIGIN);
    return f.request(path, { ...init, headers });
  });
  await client.ownerSaveEvent("default", {
    title: "Saved",
    slug: "intro",
    description: "Saved description",
    durationMinutes: 60,
    location: "Current private room",
  });
  await client.ownerSaveRules("default", {
    intervalMinutes: 15,
    noticeMinutes: 30,
    beforeMinutes: 5,
    afterMinutes: 10,
    disableCancelling: true,
    disableRescheduling: true,
    bookingWindowDays: 14,
  });
  await client.ownerSetVisibility("default", true);
  await client.ownerSetVisibility("default", true);
  const source = await client.ownerEvent("default");
  const details = { title: "Copy", slug: "copy", description: "Literal <copy>", durationMinutes: 45 };
  const copy = await client.ownerDuplicateEvent("default", details);
  assert.notEqual(copy.id, source.id);
  assert.deepEqual(copy.event, { ...source.event, ...details });
  assert.equal(copy.lifecycle, "hidden");
  const duplicateCall = calls.find((call) => call.path.endsWith("/duplicate"));
  assert.equal(duplicateCall?.init.body, JSON.stringify(details));
  await client.ownerRemoveEvent(copy.id);
  await client.ownerRemoveEvent(copy.id);
  assert.equal(calls.at(-1)?.init.method, "DELETE");
  assert.equal(calls.at(-1)?.init.body, undefined);
  for (const call of calls) {
    assert.equal(call.init.credentials, "same-origin");
    assert.equal(call.init.cache, "no-store");
    assert.ok(call.init.signal instanceof AbortSignal);
  }
  for (const value of [
    null,
    { ...copy, id: "default" },
    { ...copy, id: source.id },
    { ...copy, lifecycle: "removed" },
    { ...copy, private: true },
    ...Object.keys(details).map((key) => ({ ...copy, event: { ...copy.event, [key]: "wrong" } })),
  ])
    await assert.rejects(
      new BookerClient(async () => Response.json(value)).ownerDuplicateEvent(source.id, details),
      ErrorWithCode
    );
  for (const value of [null, {}, { saved: false }, { saved: true, private: true }]) {
    const invalid = new BookerClient(async () => Response.json(value));
    await assert.rejects(invalid.ownerSetVisibility(source.id, false), ErrorWithCode);
    await assert.rejects(invalid.ownerRemoveEvent(source.id), ErrorWithCode);
  }
  const staleCopy = { ...copy, event: { ...copy.event, location: "New saved location", noticeMinutes: 90 } };
  assert.deepEqual(
    await new BookerClient(async () => Response.json(staleCopy)).ownerDuplicateEvent(source.id, details),
    staleCopy
  );
  assert.equal(f.calendar.writes.length, 0);
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

test("booking command states require their literal action and error combinations", async () => {
  const access = { id: "a".repeat(64), token: "b".repeat(43) };
  const valid = {
    id: access.id,
    version: 0,
    start: Date.UTC(2030, 0, 1),
    end: Date.UTC(2030, 0, 1, 0, 30),
    name: "",
    email: "<literal>\u0000\ud800",
    title: "東京 😀",
    timeZone: "UTC",
  };
  const accepted = new Set([
    "pending/create/undefined",
    "confirmed/undefined/undefined",
    "rescheduling/reschedule/undefined",
    "cancelling/cancel/undefined",
    "cancelled/undefined/undefined",
    "attention/create/",
    "attention/create/provider_failure",
    "attention/reschedule/",
    "attention/reschedule/provider_failure",
    "attention/cancel/",
    "attention/cancel/provider_failure",
  ]);
  for (const status of ["pending", "confirmed", "rescheduling", "cancelling", "cancelled", "attention"])
    for (const pendingAction of [undefined, "create", "reschedule", "cancel", "other", null])
      for (const error of [undefined, "", "provider_failure", null]) {
        const value = { ...valid, status, pendingAction, error };
        const result = new BookerClient(async () => Response.json(value)).view(access);
        if (accepted.has(`${status}/${pendingAction}/${error}`))
          assert.deepEqual(await result, JSON.parse(JSON.stringify(value)));
        else
          await assert.rejects(result, (error: unknown) => {
            assert.ok(error instanceof ErrorWithCode);
            assert.equal(error.code, "invalid_response");
            assert.equal(error.message, "invalid_response");
            assert.equal(error.status, 200);
            assert.equal(error.retryable, true);
            return true;
          });
      }
});

test("booking projections preserve property order, zero, false and optional own-property distinctions", async () => {
  const access = { id: "a".repeat(64), token: "b".repeat(43) };
  const valid = {
    location: "Private\u0000\ud800",
    rescheduleReason: "Move\r\n é 😀",
    manageToken: access.token,
    disableRescheduling: false,
    disableCancelling: false,
    timeZone: "UTC",
    title: "<Call>",
    email: "",
    name: "",
    end: 1893457800000,
    start: 1893456000000,
    version: 0,
    status: "confirmed",
    id: access.id,
    credential: "private",
    notes: "private",
    guests: ["private@example.test"],
    pendingAction: undefined,
    error: undefined,
  };
  const response = new Response();
  response.json = async () => valid;
  const result = await new BookerClient(async () => response).view(access);
  assert.equal(
    JSON.stringify(result),
    '{"id":"aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa","status":"confirmed","version":0,"start":1893456000000,"end":1893457800000,"name":"","email":"","title":"<Call>","timeZone":"UTC","disableCancelling":false,"disableRescheduling":false,"manageToken":"bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb","rescheduleReason":"Move\\r\\n é 😀","location":"Private\\u0000\\ud800"}'
  );
  assert.equal(Object.hasOwn(result, "pendingAction"), false);
  assert.equal(Object.hasOwn(result, "error"), false);
  for (const key of ["cancellationReason", "rescheduleReason", "location"]) {
    response.json = async () => ({ ...valid, [key]: undefined });
    await assert.rejects(new BookerClient(async () => response).view(access), /invalid_response/);
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
