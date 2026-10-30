import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, type ChangeRequest, ErrorWithCode } from "../src/client/bookings.ts";
import { defaultSettings, parseSettings } from "../src/domain/settings.ts";
import { BookingService } from "../src/server/bookings.ts";
import { GoogleCalendarError } from "../src/server/google.ts";
import { record } from "../src/server/http.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

test("calendar discovery is owner-only, private and independent of settings and booking work", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let calls = 0;
  let status = 200;
  globalThis.fetch = async (input, init) => {
    if (String(input).startsWith("https://www.googleapis.com/")) {
      calls++;
      assert.equal(init?.method, "GET");
      assert.equal(new URL(String(input)).pathname, "/calendar/v3/users/me/calendarList");
      return Response.json(
        status === 200
          ? {
              items: [
                {
                  id: "private-calendar-id",
                  summary: "Private calendar name",
                  accessRole: "reader",
                  selected: false,
                },
              ],
            }
          : { error: { message: "Private calendar name private-calendar-id TOKEN" } },
        { status }
      );
    }
    return realFetch(input, init);
  };
  const path = "/api/owner/conflict-calendars";
  const snapshot = async () =>
    Promise.all([
      ...[
        "organizer_settings",
        "booking",
        "booking_command",
        "booking_reservation",
        "http_attempt",
        "http_rate",
        "google_connection",
        "owner_session",
      ].map(async (table) => (await f.db.prepare(`SELECT * FROM ${table}`).all()).results),
    ]);
  const before = await snapshot();
  for (const headers of [
    {},
    { Authorization: `Bearer ${"B".repeat(43)}` },
    { Cookie: `flare_session=${"A".repeat(43)}` },
  ]) {
    const response = await f.request(`${path}?invalid=%ZZ`, { headers });
    assert.equal(response.status, 401);
    assert.equal(response.headers.get("Cache-Control"), "no-store");
    assert.deepEqual(await response.json(), { error: "unauthorized", message: "unauthorized" });
  }
  assert.equal((await f.request(`${path}?invalid=%ZZ`, { headers: f.ownerHeaders })).status, 400);
  assert.equal(calls, 0);
  const response = await f.request(path, { headers: f.ownerHeaders });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  assert.match(response.headers.get("Content-Type") ?? "", /application\/json/);
  assert.deepEqual(await response.json(), {
    calendars: [{ id: "private-calendar-id", name: "Private calendar name", primary: false }],
    conflictCalendarIds: null,
  });
  status = 403;
  const failed = await f.request(path, { headers: f.ownerHeaders });
  assert.equal(failed.status, 503);
  assert.deepEqual(await failed.json(), { error: "GOOGLE_CALENDAR" });
  for (const route of ["/api/owner", "/api/public"]) {
    const ordinary = await f.request(route, { headers: f.ownerHeaders });
    assert.equal(ordinary.status, 200);
    assert.ok(!(await ordinary.text()).includes("private-calendar"));
  }
  assert.equal(calls, 2);
  assert.deepEqual(await snapshot(), before);
  assert.equal(f.calendar.writes.length, 0);
  await f.db.prepare("UPDATE owner_session SET expires_at=0").run();
  assert.equal((await f.request(path, { headers: f.ownerHeaders })).status, 401);
  await f.db.prepare("DELETE FROM owner_session").run();
  assert.equal((await f.request(path, { headers: f.ownerHeaders })).status, 401);
  assert.equal(calls, 2);
});

test("owner details and required-reason cancellation use session authorization and immutable replay", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const client = new BookerClient((path, init) =>
    f.request(path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        ...f.ownerHeaders,
        Origin: f.env.PUBLIC_ORIGIN,
      },
    })
  );
  const created = record(
    await (
      await f.send("/api/bookings", {
        requestKey: "owner-cancel-create-0001",
        start: f.now() + 9 * hour,
        name: "Private guest",
        email: "guest@example.test",
        timeZone: "Asia/Manila",
      })
    ).json()
  );
  assert.equal(typeof created.id, "string");
  const id = String(created.id),
    path = `/api/owner/bookings/${id}`;
  const input = {
    action: "cancel",
    requestKey: "owner-cancel-request-0001",
    version: 1,
    cancellationReason: "  First\n😀 <literal>  ",
  };
  for (const headers of [
    {},
    { Authorization: `Bearer ${created.manageToken}` },
    { Cookie: `flare_session=${"A".repeat(43)}` },
  ]) {
    assert.equal((await f.request(path, { headers })).status, 401);
    assert.equal((await f.send(path, input, headers)).status, 401);
  }
  assert.equal(
    (await f.send(path, input, { ...f.ownerHeaders, Origin: "https://foreign.test" })).status,
    403
  );
  assert.equal((await f.request("/api/owner/bookings/invalid", { headers: f.ownerHeaders })).status, 404);
  const view = await client.ownerView(id);
  assert.equal(view.title, settings.event.title);
  assert.equal(view.timeZone, "Asia/Manila");
  assert.equal(view.manageToken, undefined);
  assert.equal(f.calendar.writes.length, 1);
  for (const cancellationReason of [undefined, "", " \n\t", "x".repeat(1001), `${"😀".repeat(500)}x`])
    assert.equal((await f.send(path, { ...input, cancellationReason }, f.ownerHeaders)).status, 400);
  assert.equal(
    (await f.send(path, { ...input, action: "reschedule", start: f.now() + 10 * hour }, f.ownerHeaders))
      .status,
    400
  );
  assert.equal(await f.db.prepare("SELECT count(*) FROM booking_command").first("count(*)"), 1);
  const later = new BookingService({
    db: f.db,
    calendar: f.calendar,
    settings,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: () => f.now() + 48 * hour,
  });
  await assert.rejects(
    later.ownerChange(id, { ...input, requestKey: "ended-owner-cancel-0001" }),
    /invalid_slot/
  );
  const accepted = await client.ownerCancel(id, { ...input, action: "cancel" });
  assert.equal(accepted.status, "cancelled");
  assert.equal(accepted.cancellationReason, "First\n😀 <literal>");
  await f.send(
    "/api/owner",
    { ...settings, event: { ...settings.event, disableCancelling: true } },
    f.ownerHeaders,
    "PUT"
  );
  assert.deepEqual(await client.ownerCancel(id, { ...input, action: "cancel" }), await client.ownerView(id));
  assert.equal((await client.ownerView(id)).cancellationReason, "First\n😀 <literal>");
  assert.deepEqual(
    f.calendar.writes.map((write) => write.action),
    ["insert", "delete"]
  );
  assert.equal(await f.db.prepare("SELECT count(*) FROM booking_reservation").first("count(*)"), 0);
  assert.equal(
    await f.db.prepare("SELECT count(*) FROM booking_command WHERE outcome='accepted'").first("count(*)"),
    2
  );
  await f.db.prepare("UPDATE owner_session SET expires_at=0").run();
  assert.equal((await f.request(path, { headers: f.ownerHeaders })).status, 401);
  assert.equal((await f.send(path, input, f.ownerHeaders)).status, 401);
  await f.db.prepare("DELETE FROM owner_session").run();
  assert.equal((await f.request(path, { headers: f.ownerHeaders })).status, 401);
});

test("fresh owner cancellation retains policy, stale and attention outcomes while accepted recovery survives policy changes", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const created = record(
    await (
      await f.send("/api/bookings", {
        requestKey: "owner-policy-create-0001",
        start: f.now() + 9 * hour,
        name: "Guest",
        email: "guest@example.test",
        timeZone: "UTC",
      })
    ).json()
  );
  const id = String(created.id),
    path = `/api/owner/bookings/${id}`;
  const input = {
    action: "cancel",
    requestKey: "owner-policy-cancel-0001",
    version: 1,
    cancellationReason: "x".repeat(1000),
  };
  const setDisabled = (disableCancelling: boolean) =>
    f.send(
      "/api/owner",
      { ...settings, event: { ...settings.event, disableCancelling } },
      f.ownerHeaders,
      "PUT"
    );
  await setDisabled(true);
  assert.equal((await f.send(path, input, f.ownerHeaders)).status, 409);
  await setDisabled(false);
  assert.equal((await f.send(path, input, f.ownerHeaders)).status, 409);
  assert.equal(
    (await f.send(path, { ...input, requestKey: "owner-stale-cancel-0001", version: 2 }, f.ownerHeaders))
      .status,
    409
  );
  const remote = f.calendar.events.get(id);
  assert.ok(remote);
  f.calendar.events.set(id, { ...remote, summary: "External edit" });
  const accepted = {
    ...input,
    requestKey: "owner-accepted-cancel-0001",
    cancellationReason: `  ${input.cancellationReason}  `,
  };
  const pending = record(await (await f.send(path, accepted, f.ownerHeaders)).json());
  assert.equal(pending.status, "attention");
  assert.equal(pending.error, "event_changed");
  const commands = (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results;
  for (let n = 0; n < 2; n++)
    assert.equal(
      record(await (await f.request(path, { headers: f.ownerHeaders })).json()).status,
      "attention"
    );
  assert.deepEqual(
    (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
    commands
  );
  assert.equal(
    (await f.send(path, { ...input, requestKey: "owner-busy-cancel-00001" }, f.ownerHeaders)).status,
    409
  );
  assert.equal(f.calendar.writes.length, 1);
  f.calendar.events.set(id, remote);
  await setDisabled(true);
  f.calendar.cutAfter = "delete";
  assert.equal((await f.send(path, accepted, f.ownerHeaders)).status, 202);
  assert.equal(record(await (await f.request(path, { headers: f.ownerHeaders })).json()).status, "attention");
  const recovered = record(await (await f.send("/api/owner/retry", { id }, f.ownerHeaders)).json());
  assert.equal(recovered.status, "cancelled");
  assert.equal(recovered.cancellationReason, input.cancellationReason);
  assert.deepEqual(
    f.calendar.writes.map((write) => write.action),
    ["insert", "delete"]
  );
  for (const value of [
    { ...recovered, manageToken: created.manageToken },
    { ...recovered, id: "b".repeat(64) },
  ])
    await assert.rejects(
      new BookerClient(async () => Response.json(value)).ownerView(id),
      /invalid_response/
    );
});

test("booking rule updates preserve concurrent settings and change slot spacing, buffers and notice", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { send, request, db, ownerHeaders, calendar } = fixture;
  const rules = {
    intervalMinutes: 60,
    beforeMinutes: 15,
    afterMinutes: 20,
    noticeMinutes: 0,
    disableCancelling: true,
    disableRescheduling: false,
  };
  const patch = (value: unknown) => send("/api/owner/booking-rules", value, ownerHeaders, "PATCH");
  const row = () =>
    db
      .prepare("SELECT json,version FROM organizer_settings WHERE id='owner'")
      .first<{ json: string; version: number }>();
  const before = await row();
  assert.equal((await send("/api/owner/booking-rules", rules, {}, "PATCH")).status, 401);
  assert.equal(
    (
      await send(
        "/api/owner/booking-rules",
        rules,
        { ...ownerHeaders, Origin: "https://foreign.example" },
        "PATCH"
      )
    ).status,
    403
  );
  for (const value of [
    null,
    { ...rules, durationMinutes: 45 },
    ...Object.keys(rules).map((key) =>
      Object.fromEntries(Object.entries(rules).filter(([name]) => name !== key))
    ),
    ...["disableCancelling", "disableRescheduling"].flatMap((key) =>
      [null, "false", 0].map((value) => ({ ...rules, [key]: value }))
    ),
    ...(
      [
        ["intervalMinutes", 5, 240],
        ["beforeMinutes", 0, 120],
        ["afterMinutes", 0, 120],
        ["noticeMinutes", 0, 43200],
      ] as const
    ).flatMap(([key, min, max]) =>
      [min - 1, max + 1, 30.5, "30"].map((value) => ({ ...rules, [key]: value }))
    ),
  ]) {
    const response = await patch(value);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_SETTINGS" });
  }
  assert.deepEqual(await row(), before);
  const details = {
    slug: "rules-event",
    title: "Retained\ud800",
    description: "Keep\udc00",
    durationMinutes: 30,
  };
  const weekly = {
    timeZone: "UTC",
    rules: Array.from({ length: 7 }, (_, weekday) => ({ weekday, startMinute: 0, endMinute: 1440 })),
  };
  const overrides = [{ date: "2030-01-04", ranges: [] }];
  const responses = await Promise.all([
    patch(rules),
    send("/api/owner", details, ownerHeaders, "PATCH"),
    send("/api/owner/schedule", weekly, ownerHeaders, "PATCH"),
    send("/api/owner/overrides", { overrides }, ownerHeaders, "PATCH"),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200, 200]
  );
  const expected = parseSettings({
    ...settings,
    event: { ...settings.event, ...details, ...rules },
    schedule: { ...weekly, overrides },
  });
  assert.deepEqual(
    record(await (await request("/api/owner", { headers: ownerHeaders })).json()).settings,
    expected
  );
  assert.deepEqual(parseSettings(await (await request("/api/public")).json()), expected);
  const stored = await row();
  assert.ok(stored && before);
  assert.equal(stored.version, before.version + 4);
  assert.equal(stored.json, JSON.stringify(expected));
  const from = fixture.now() + 8 * hour;
  calendar.busy = async () => [{ start: fixture.now() + 9 * hour, end: fixture.now() + 10 * hour }];
  const slots = async () =>
    record(
      await (
        await request(
          `/api/slots?${new URLSearchParams({ from: new Date(from).toISOString(), to: new Date(from + 4 * hour).toISOString(), timeZone: "UTC" })}`
        )
      ).json()
    ).slots;
  assert.deepEqual(
    await slots(),
    [8, 11].map((hours) => ({
      start: fixture.now() + hours * hour,
      end: fixture.now() + hours * hour + 30 * 60_000,
    }))
  );
  assert.equal((await patch({ ...rules, noticeMinutes: 43200 })).status, 200);
  assert.deepEqual(await slots(), []);
  await db.prepare("DELETE FROM organizer_settings WHERE id='owner'").run();
  assert.equal((await patch(rules)).status, 200);
  assert.equal(
    (await row())?.json,
    JSON.stringify({ ...defaultSettings, event: { ...defaultSettings.event, ...rules } })
  );
  assert.equal((await row())?.version, 1);
  assert.equal(calendar.writes.length, 0);
});

test("dated override updates preserve independent settings and reject invalid or unauthorized input", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { send, request, ownerHeaders, db, calendar } = fixture;
  const overrides = [
    { date: "2030-01-02", ranges: [] },
    {
      date: "2030-01-03",
      ranges: [
        { startMinute: 0, endMinute: 720 },
        { startMinute: 720, endMinute: 1440 },
      ],
    },
    { date: "2032-02-29", ranges: [] },
  ];
  const row = () =>
    db
      .prepare("SELECT json,version FROM organizer_settings WHERE id='owner'")
      .first<{ json: string; version: number }>();
  const before = await row();
  const patch = (value: unknown) => send("/api/owner/overrides", value, ownerHeaders, "PATCH");
  assert.equal((await send("/api/owner/overrides", { overrides }, {}, "PATCH")).status, 401);
  assert.equal(
    (
      await send(
        "/api/owner/overrides",
        { overrides },
        {
          ...ownerHeaders,
          Origin: "https://foreign.example",
        },
        "PATCH"
      )
    ).status,
    403
  );
  for (const value of [
    null,
    {},
    { overrides: null },
    { overrides: [], rules: [] },
    { overrides: [{ date: "2030-02-29", ranges: [] }] },
    { overrides: [{ date: "2030-1-02", ranges: [] }] },
    { overrides: [overrides[0], overrides[0]] },
    { overrides: [{ date: "2030-01-02", ranges: [{ startMinute: 720, endMinute: 720 }] }] },
    { overrides: [{ date: "2030-01-02", ranges: [{ startMinute: "0", endMinute: 1440 }] }] },
    {
      overrides: [
        {
          date: "2030-01-02",
          ranges: [
            { startMinute: 0, endMinute: 100 },
            { startMinute: 99, endMinute: 200 },
          ],
        },
      ],
    },
    {
      overrides: [
        {
          date: "2030-01-02",
          ranges: Array.from({ length: 101 }, (_, i) => ({ startMinute: i, endMinute: i + 1 })),
        },
      ],
    },
    {
      overrides: Array.from({ length: 367 }, (_, i) => ({
        date: new Date(Date.UTC(2032, 0, i + 1)).toISOString().slice(0, 10),
        ranges: [],
      })),
    },
  ]) {
    const response = await patch(value);
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_SETTINGS" });
  }
  assert.deepEqual(await row(), before);
  const original = parseSettings({
    ...settings,
    event: { ...settings.event, beforeMinutes: 10, disableCancelling: true },
    schedule: { ...settings.schedule, overrides: [{ date: "2030-01-01", ranges: [] }] },
  });
  assert.equal((await send("/api/owner", original, ownerHeaders, "PUT")).status, 200);
  const details = {
    slug: "override-event",
    title: "Retained\ud800",
    description: "Keep\udc00",
    durationMinutes: 45,
  };
  const weekly = { timeZone: "Asia/Kolkata", rules: [{ weekday: 1, startMinute: 540, endMinute: 1020 }] };
  const responses = await Promise.all([
    patch({ overrides }),
    send("/api/owner", details, ownerHeaders, "PATCH"),
    send("/api/owner/schedule", weekly, ownerHeaders, "PATCH"),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200, 200]
  );
  const expected = parseSettings({
    ...original,
    event: { ...original.event, ...details },
    schedule: { ...weekly, overrides },
  });
  assert.deepEqual(
    record(await (await request("/api/owner", { headers: ownerHeaders })).json()).settings,
    expected
  );
  assert.deepEqual(parseSettings(await (await request("/api/public")).json()), expected);
  const stored = await row();
  assert.ok(stored && before);
  assert.equal(stored.version, before.version + 4);
  assert.equal(stored.json, JSON.stringify(expected));
  assert.equal((await patch({ overrides: [] })).status, 200);
  assert.equal(
    (await row())?.json,
    JSON.stringify({ ...expected, schedule: { ...expected.schedule, overrides: [] } })
  );
  await db.prepare("DELETE FROM organizer_settings WHERE id='owner'").run();
  assert.equal((await patch({ overrides })).status, 200);
  assert.equal(
    (await row())?.json,
    JSON.stringify({ ...defaultSettings, schedule: { ...defaultSettings.schedule, overrides } })
  );
  assert.equal((await row())?.version, 1);
  assert.equal(calendar.writes.length, 0);
});

test("weekly updates preserve overrides and concurrent event edits, rejecting invalid or unauthorized input", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { send, request, ownerHeaders, db, calendar } = fixture;
  const weekly = {
    timeZone: "Asia/Kolkata",
    rules: [
      { weekday: 1, startMinute: 540, endMinute: 720 },
      { weekday: 1, startMinute: 780, endMinute: 1020 },
      { weekday: 2, startMinute: 0, endMinute: 1440 },
    ],
  };
  const row = () =>
    db
      .prepare("SELECT json,version FROM organizer_settings WHERE id='owner'")
      .first<{ json: string; version: number }>();
  const before = await row();
  assert.equal((await send("/api/owner/schedule", weekly, {}, "PATCH")).status, 401);
  assert.equal(
    (
      await send(
        "/api/owner/schedule",
        weekly,
        { ...ownerHeaders, Origin: "https://foreign.example" },
        "PATCH"
      )
    ).status,
    403
  );
  for (const value of [
    null,
    {},
    { timeZone: "UTC" },
    { rules: [] },
    { ...weekly, timeZone: "Invalid/Zone" },
    { ...weekly, overrides: [] },
    { ...weekly, rules: [{ weekday: 7, startMinute: 0, endMinute: 1440 }] },
    { ...weekly, rules: [{ weekday: 1, startMinute: 10, endMinute: 10 }] },
    { ...weekly, rules: [{ weekday: 1, startMinute: "540", endMinute: 720 }] },
    { ...weekly, rules: [...weekly.rules, { weekday: 1, startMinute: 600, endMinute: 800 }] },
    {
      ...weekly,
      rules: Array.from({ length: 29 }, (_, index) => ({
        weekday: 1,
        startMinute: index * 2,
        endMinute: index * 2 + 1,
      })),
    },
  ]) {
    const response = await send("/api/owner/schedule", value, ownerHeaders, "PATCH");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_SETTINGS" });
  }
  assert.deepEqual(await row(), before);
  const original = parseSettings({
    ...settings,
    event: {
      ...settings.event,
      beforeMinutes: 10,
      afterMinutes: 20,
      disableCancelling: true,
      disableRescheduling: false,
    },
    schedule: { ...settings.schedule, overrides: [{ date: "2030-01-04", ranges: [] }] },
  });
  assert.equal((await send("/api/owner", original, ownerHeaders, "PUT")).status, 200);
  const details = {
    slug: "updated-event",
    title: "Retained event details",
    description: "Keep me\udc00",
    durationMinutes: 45,
  };
  const responses = await Promise.all([
    send("/api/owner", details, ownerHeaders, "PATCH"),
    send("/api/owner/schedule", weekly, ownerHeaders, "PATCH"),
  ]);
  assert.deepEqual(
    responses.map((response) => response.status),
    [200, 200]
  );
  const expected = parseSettings({
    ...original,
    event: { ...original.event, ...details },
    schedule: { ...original.schedule, ...weekly },
  });
  const owner = record(await (await request("/api/owner", { headers: ownerHeaders })).json());
  assert.deepEqual(owner.settings, expected);
  assert.deepEqual(parseSettings(await (await request("/api/public")).json()), expected);
  const stored = await row();
  assert.ok(stored && before);
  assert.equal(stored.version, before.version + 3);
  assert.equal(stored.json, JSON.stringify(expected));
  assert.equal(
    (await send("/api/owner/schedule", { timeZone: "UTC", rules: [] }, ownerHeaders, "PATCH")).status,
    200
  );
  const closed = await request(
    `/api/slots?${new URLSearchParams({ from: "2030-01-02T00:00:00Z", to: "2030-01-03T00:00:00Z", timeZone: "UTC" })}`
  );
  assert.equal(closed.status, 200);
  assert.deepEqual(await closed.json(), { slots: [] });
  await db.prepare("DELETE FROM organizer_settings WHERE id='owner'").run();
  assert.equal((await send("/api/owner/schedule", weekly, ownerHeaders, "PATCH")).status, 200);
  assert.equal((await row())?.json, JSON.stringify({ ...defaultSettings, schedule: weekly }));
  assert.equal((await row())?.version, 1);
  assert.equal(calendar.writes.length, 0);
});

test("owner listing preserves pending projections and does not process provider operations", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { db, calendar, env, request, ownerHeaders } = fixture;
  const service = new BookingService({
    db,
    calendar,
    settings,
    secret: env.TOKEN_ENCRYPTION_KEY,
    now: fixture.now,
  });
  const expected = [];
  for (let index = 0; index < 60; index++) {
    calendar.cutAfter = "insert";
    const { manageToken, ...view } = await service.create({
      requestKey: crypto.randomUUID(),
      start: fixture.now() + (10 + index) * hour,
      name: `Guest ${index}`,
      email: `guest${index}@example.test`,
      timeZone: "UTC",
    });
    assert.ok(manageToken);
    assert.equal(view.status, "attention");
    expected.unshift(view);
  }
  const state = async () =>
    Promise.all(
      ["booking", "booking_command", "booking_reservation"].map(
        async (table) => (await db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results
      )
    );
  const before = await state(),
    writes = calendar.writes.length;
  calendar.busy = async () => {
    throw new Error("Owner reads must not query Calendar");
  };
  calendar.get = async () => {
    throw new Error("Owner reads must not reconcile Calendar");
  };
  const response = await request("/api/owner", { headers: ownerHeaders });
  assert.equal(response.status, 200);
  assert.deepEqual(record(await response.json()).bookings, expected);
  assert.deepEqual(await state(), before);
  assert.equal(calendar.writes.length, writes);
  const denied = await request("/api/owner");
  assert.equal(denied.status, 401);
  assert.ok(!(await denied.text()).includes("guest0@example.test"));
});

test("owner detail edits preserve independent scheduling settings and require authorized valid input", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { send, request, db, ownerHeaders, calendar } = fixture;
  const details = {
    title: 'A "new" event ☀',
    slug: "new-event",
    description: "Line one\nLine two",
    durationMinutes: 45,
  };
  const read = async () => {
    const response = await request("/api/owner", { headers: ownerHeaders });
    assert.equal(response.status, 200);
    return parseSettings(record(await response.json()).settings);
  };
  const row = () =>
    db
      .prepare("SELECT json,version FROM organizer_settings WHERE id='owner'")
      .first<{ json: string; version: number }>();
  const before = await row();
  assert.equal((await send("/api/owner", details, {}, "PATCH")).status, 401);
  assert.equal(
    (await send("/api/owner", details, { ...ownerHeaders, Origin: "https://foreign.example" }, "PATCH"))
      .status,
    403
  );
  for (const invalid of [
    { ...details, slug: "api" },
    { ...details, title: " " },
    { ...details, durationMinutes: 4 },
    { ...details, durationMinutes: "45" },
    { ...details, noticeMinutes: 0 },
    ...Object.keys(details).map((key) =>
      Object.fromEntries(Object.entries(details).filter(([name]) => name !== key))
    ),
  ]) {
    const response = await send("/api/owner", invalid, ownerHeaders, "PATCH");
    assert.equal(response.status, 400);
    assert.deepEqual(await response.json(), { error: "INVALID_SETTINGS" });
  }
  assert.deepEqual(await row(), before);
  const independent = parseSettings({
    ...settings,
    event: {
      ...settings.event,
      intervalMinutes: 15,
      beforeMinutes: 10,
      afterMinutes: 20,
      noticeMinutes: 60,
      disableCancelling: true,
      disableRescheduling: false,
    },
    schedule: {
      ...settings.schedule,
      timeZone: "America/New_York",
      overrides: [{ date: "2030-01-02", ranges: [] }],
    },
  });
  const put = send("/api/owner", independent, ownerHeaders, "PUT");
  assert.equal((await put).status, 200);
  assert.equal((await send("/api/owner", details, ownerHeaders, "PATCH")).status, 200);
  const expected = { ...independent, event: { ...independent.event, ...details } };
  assert.deepEqual(await read(), expected);
  const stored = await row();
  assert.ok(stored && before);
  assert.equal(stored.version, before.version + 2);
  assert.equal(
    stored.json,
    JSON.stringify(expected),
    "Detail updates retain canonical booking-admission JSON"
  );
  assert.deepEqual(record(await (await request("/api/public")).json()).event, expected.event);
  for (const text of ["edge\ud800", "edge\udc00", "edge\u0000\n☀😀"]) {
    const next = { ...details, title: text, description: text };
    assert.equal((await send("/api/owner", next, ownerHeaders, "PATCH")).status, 200);
    const roundTrip = { ...independent, event: { ...independent.event, ...next } };
    assert.deepEqual(await read(), roundTrip, "PATCH must preserve every accepted text value");
    assert.equal((await row())?.json, JSON.stringify(roundTrip));
    assert.deepEqual(record(await (await request("/api/public")).json()).event, roundTrip.event);
  }
  await db.prepare("DELETE FROM organizer_settings WHERE id='owner'").run();
  assert.equal((await send("/api/owner", details, ownerHeaders, "PATCH")).status, 200);
  assert.deepEqual(await read(), {
    ...defaultSettings,
    event: { ...defaultSettings.event, ...details },
  });
  assert.equal((await row())?.version, 1);
  assert.equal(calendar.writes.length, 0);
});

test("current event policy refuses new guest changes without revoking durable outcomes", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { request, send, calendar, db, ownerHeaders } = fixture;
  const client = new BookerClient((path, init) =>
    request(path, {
      ...init,
      headers: { Origin: fixture.env.PUBLIC_ORIGIN, ...init.headers },
    })
  );
  let reads = 0;
  const busy = calendar.busy.bind(calendar),
    get = calendar.get.bind(calendar);
  calendar.busy = async (...args) => {
    reads++;
    return busy(...args);
  };
  calendar.get = async (...args) => {
    reads++;
    return get(...args);
  };
  const configure = async (disableCancelling: boolean, disableRescheduling: boolean) => {
    const next = { ...settings, event: { ...settings.event, disableCancelling, disableRescheduling } };
    const response = await send(
      "/api/owner/booking-rules",
      {
        intervalMinutes: settings.event.intervalMinutes,
        beforeMinutes: settings.event.beforeMinutes,
        afterMinutes: settings.event.afterMinutes,
        noticeMinutes: settings.event.noticeMinutes,
        disableCancelling,
        disableRescheduling,
      },
      ownerHeaders,
      "PATCH"
    );
    assert.equal(response.status, 200, await response.text());
    assert.deepEqual((await client.publicData()).event, next.event);
  };
  const state = async (id: string) => ({
    booking: await db.prepare("SELECT * FROM booking WHERE id=?").bind(id).first(),
    reservations: (
      await db.prepare("SELECT * FROM booking_reservation WHERE booking_id=? ORDER BY role").bind(id).all()
    ).results,
    event: structuredClone(calendar.events.get(id)),
  });
  for (const [index, action] of ["cancel", "reschedule"].entries()) {
    assert.ok(action === "cancel" || action === "reschedule");
    await configure(false, false);
    const created = await client.create({
      requestKey: crypto.randomUUID(),
      start: fixture.now() + (10 + index * 24) * hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    });
    assert.ok(created.manageToken);
    const access = { id: created.id, token: created.manageToken };
    const change: ChangeRequest =
      action === "cancel"
        ? { action, requestKey: crypto.randomUUID(), version: created.version }
        : {
            action,
            requestKey: crypto.randomUUID(),
            version: created.version,
            start: created.start + 2 * hour,
          };
    await configure(action === "cancel", action === "reschedule");
    const before = await state(created.id),
      beforeReads = reads,
      writes = calendar.writes.length;
    const denied = (error: unknown) =>
      error instanceof ErrorWithCode && error.status === 409 && error.code === "invalid_slot";
    await assert.rejects(client.change(access, change), denied);
    assert.equal(reads, beforeReads, "Disabled changes must not read Calendar");
    assert.equal(calendar.writes.length, writes);
    assert.deepEqual(await state(created.id), before);
    assert.equal(
      await db
        .prepare("SELECT outcome FROM booking_command WHERE request_key=?")
        .bind(change.requestKey)
        .first("outcome"),
      "invalid_slot"
    );
    await configure(false, false);
    await assert.rejects(client.change(access, change), denied);
    assert.equal(reads, beforeReads, "Re-enabling cannot change a persisted refusal");
    assert.deepEqual(await state(created.id), before);
    const allowed = { ...change, requestKey: crypto.randomUUID() };
    const result = await client.change(access, allowed);
    assert.equal(result.status, action === "cancel" ? "cancelled" : "confirmed");
    assert.equal(result.start, action === "cancel" ? created.start : created.start + 2 * hour);
    const acceptedWrites = calendar.writes.length;
    await configure(action === "cancel", action === "reschedule");
    assert.deepEqual(await client.change(access, allowed), {
      ...result,
      disableCancelling: action === "cancel",
      disableRescheduling: action === "reschedule",
    });
    assert.equal(calendar.writes.length, acceptedWrites, "Accepted replay survives a policy change");
    await configure(action !== "cancel", action !== "reschedule");
    const other = await client.create({
      requestKey: crypto.randomUUID(),
      start: fixture.now() + (18 + index * 24) * hour,
      name: "Other guest",
      email: "other@example.test",
      timeZone: "UTC",
    });
    assert.ok(other.manageToken);
    const otherChange: ChangeRequest =
      action === "cancel"
        ? { action, requestKey: crypto.randomUUID(), version: other.version }
        : { action, requestKey: crypto.randomUUID(), version: other.version, start: other.start + 2 * hour };
    const otherAccess = { id: other.id, token: other.manageToken };
    calendar.cutAfter = action === "cancel" ? "delete" : "update";
    assert.equal(
      (await client.change(otherAccess, otherChange)).status,
      "attention",
      "The other policy must not prevent admission or provider dispatch"
    );
    const afterDispatch = calendar.writes.length;
    await configure(true, true);
    const recovered = await client.change(otherAccess, otherChange);
    assert.equal(recovered.status, action === "cancel" ? "cancelled" : "confirmed");
    assert.equal(recovered.start, action === "cancel" ? other.start : other.start + 2 * hour);
    assert.equal(
      calendar.writes.length,
      afterDispatch,
      "An accepted uncertain change reconciles after policy changes without another write"
    );
  }
});

test("migrated booking flow runs over HTTP with local D1 and fixture Calendar", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { request, send, calendar, ownerHeaders } = fixture;
  const read = async (response: Response, status = 200) => {
    const text = await response.text();
    assert.equal(response.status, status, text);
    assert.equal(response.headers.get("cache-control"), "no-store");
    return JSON.parse(text);
  };
  const publicData = await read(await request("/api/public"));
  assert.equal(publicData.organizer.name, "Organizer");
  assert.equal(JSON.stringify(publicData).includes(fixture.env.GOOGLE_OWNER_EMAIL), false);
  await read(await request("/api/owner"), 401);
  const updated = { ...settings, event: { ...settings.event, title: "Updated title" } };
  await read(await send("/api/owner", updated, ownerHeaders, "PUT"));
  const owner = await read(await request("/api/owner", { headers: ownerHeaders }));
  assert.equal(owner.settings.event.title, updated.event.title);
  for (const secret of [fixture.session, fixture.ciphertext, fixture.env.TOKEN_ENCRYPTION_KEY])
    assert.equal(JSON.stringify(owner).includes(secret), false);
  const start = fixture.now() + 10 * hour;
  const query = new URLSearchParams({
    from: new Date(fixture.now()).toISOString(),
    to: new Date(fixture.now() + 24 * hour).toISOString(),
    timeZone: "UTC",
  });
  const slots = await read(await request(`/api/slots?${query}`));
  assert.ok(slots.slots.some((slot: { start: number }) => slot.start === start));
  const input = {
    requestKey: crypto.randomUUID(),
    start,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
  };
  await read(await send("/api/bookings", input, { Origin: "https://foreign.example" }), 403);
  const created = await read(await send("/api/bookings", input), 201);
  assert.equal(created.start, start);
  assert.deepEqual(await read(await send("/api/bookings", input), 201), created);
  assert.equal(calendar.writes.length, 1);
  const path = `/api/bookings/${created.id}`;
  const headers = { Authorization: `Bearer ${created.manageToken}` };
  await read(await request(path), 401);
  const denied = await read(
    await request(path, { headers: { Authorization: `Bearer ${"A".repeat(43)}` } }),
    404
  );
  assert.equal(JSON.stringify(denied).includes(input.email), false);
  const view = await read(await request(path, { headers }));
  assert.equal(view.title, updated.event.title);
  assert.equal("manageToken" in view, false);
  const move = {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: view.version,
    start: start + 2 * hour,
  };
  const moved = await read(await send(path, move, headers));
  assert.equal(moved.start, move.start);
  assert.equal(moved.id, created.id);
  calendar.cutAfter = "delete";
  const pending = await read(
    await send(path, { action: "cancel", requestKey: crypto.randomUUID(), version: moved.version }, headers),
    202
  );
  assert.equal(pending.status, "attention");
  const cancelled = await read(await send("/api/owner/retry", { id: created.id }, ownerHeaders));
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.id, created.id);
  assert.equal(calendar.events.size, 0);
  assert.deepEqual(
    calendar.writes.map((write) => [write.action, write.id]),
    [
      ["insert", created.id],
      ["update", created.id],
      ["delete", created.id],
    ]
  );
});

test("HTTP admission bounds Calendar work before availability and booking admission", async (t) => {
  const fixture = await apiFixture();
  t.after(fixture.close);
  const { request, send, calendar, db } = fixture;
  const busy = calendar.busy.bind(calendar);
  let calls = 0;
  const countedBusy: typeof calendar.busy = async (...args) => {
    calls++;
    return busy(...args);
  };
  calendar.busy = countedBusy;
  const path = `/api/slots?${new URLSearchParams({
    from: new Date(fixture.now()).toISOString(),
    to: new Date(fixture.now() + hour).toISOString(),
    timeZone: "UTC",
  })}`;
  const check = async (response: Response, status: number): Promise<void> => {
    assert.equal(response.status, status);
    const data = await response.json();
    assert.ok(typeof data === "object" && data !== null && !Array.isArray(data));
    if (status === 200) assert.ok("slots" in data && Array.isArray(data.slots) && data.slots.length > 0);
    if (status === 429) assert.equal("error" in data && data.error, "too_many_requests");
  };

  await t.test("one IP gets sixty availability requests and rejection does no Calendar work", async () => {
    for (let index = 0; index < 60; index++) {
      await check(await request(path), 200);
    }
    await check(await request(path), 429);
    assert.equal(calls, 60);
    await check(await request(path, { headers: { "CF-Connecting-IP": "192.0.2.2" } }), 200);
    assert.equal(calls, 61, "another IP can use the remaining global budget");
  });

  await t.test("one request key cannot bypass the minute limit after pre-admission failure", async () => {
    await db.prepare("DELETE FROM http_rate").run();
    calls = 0;
    calendar.busy = async (): Promise<never> => {
      calls++;
      throw new GoogleCalendarError("retryable", 503, "Fixture Calendar unavailable before admission");
    };
    const input = {
      requestKey: crypto.randomUUID(),
      start: fixture.now() + 10 * hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    };
    for (let index = 0; index < 60; index++) await check(await send("/api/bookings", input), 503);
    await check(await send("/api/bookings", input), 429);
    assert.equal(calls, 60);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM booking_command").first("n"), 0);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM booking").first("n"), 0);
    assert.equal(await db.prepare("SELECT count(*) AS n FROM http_attempt").first("n"), 1);
  });

  await t.test("different IPs compete atomically for the last global availability admission", async () => {
    await db.prepare("DELETE FROM http_rate").run();
    await db
      .prepare("INSERT INTO http_rate VALUES (?, 'slots:all', 599)")
      .bind(Math.floor(fixture.now() / 60_000))
      .run();
    calls = 0;
    calendar.busy = countedBusy;
    const responses = await Promise.all(
      ["192.0.2.3", "192.0.2.4"].map((ip) => request(path, { headers: { "CF-Connecting-IP": ip } }))
    );
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 429]);
    for (const response of responses) {
      if (response.status === 200) await check(response, 200);
      else await check(response, 429);
    }
    assert.equal(calls, 1, "the rejected global contender must not reach Calendar");
  });
});
