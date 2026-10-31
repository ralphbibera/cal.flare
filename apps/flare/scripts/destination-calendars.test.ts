import assert from "node:assert/strict";
import { test } from "node:test";
import { getOwnerEventData } from "../src/server/app.ts";
import { BookingService } from "../src/server/bookings.ts";
import { GoogleCalendar } from "../src/server/google.ts";
import { encryptionKey, seal } from "../src/server/secrets.ts";
import {
  createEvent,
  duplicateEvent,
  getDestinationCalendars,
  saveDestinationCalendar,
} from "../src/server/settings.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";
import { createGoogleFixture } from "./fixtures/google.mjs";

const target = "team+東京@group.calendar.google.com";
const details = { slug: "other", title: "Other", description: "Other event", durationMinutes: 30 };
const guest = { name: "Guest", email: "guest@example.test", timeZone: "UTC" };

test("private destination selection validates writable discovery and survives independent event mutations and zero events", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const originalFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = originalFetch;
  });
  let calls = 0,
    status = 200,
    role = "writer";
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://www.googleapis.com/")) return originalFetch(input, init);
    calls++;
    return Response.json(
      {
        items: [
          { id: "owner@example.test", summary: "Primary", primary: true, accessRole: "owner" },
          { id: target, summary: "Team <literal>", accessRole: role },
          { id: "read-only", summary: "Readable", accessRole: "reader" },
        ],
      },
      { status }
    );
  };
  const path = "/api/owner/destination-calendars";
  for (const headers of [{}, { ...f.ownerHeaders, Origin: "https://foreign.test" }]) {
    assert.ok([401, 403].includes((await f.send(path, { calendarId: target }, headers, "PATCH")).status));
  }
  assert.equal(calls, 0, "Authorization and origin precede discovery");
  for (const value of [
    {},
    { calendarId: target, extra: 1 },
    { calendarId: "read-only" },
    { calendarId: "owner@example.test" },
    { calendarId: "bad\u0000id" },
  ])
    assert.equal((await f.send(path, value, f.ownerHeaders, "PATCH")).status, 400);
  assert.deepEqual(await getDestinationCalendars(f.db), { ownerDefault: "primary", eventOverride: null });
  const saved = await f.send(path, { calendarId: target }, f.ownerHeaders, "PATCH");
  assert.equal(saved.status, 200);
  assert.deepEqual(await saved.json(), { saved: true });
  const catalog = await f.request(path, { headers: f.ownerHeaders });
  assert.equal(catalog.headers.get("Cache-Control"), "no-store");
  assert.deepEqual(await catalog.json(), {
    calendars: [
      { id: "primary", name: "Primary", primary: true },
      { id: target, name: "Team <literal>", primary: false },
    ],
    ownerDefault: target,
    eventOverride: null,
  });
  const event = await createEvent(f.db, details);
  const eventPath = `${path}?eventId=${event.id}`;
  await f.send(eventPath, { calendarId: "primary" }, f.ownerHeaders, "PATCH");
  assert.equal((await f.send("/api/owner", settings, f.ownerHeaders, "PUT")).status, 200);
  assert.deepEqual(await getDestinationCalendars(f.db, event.id), {
    ownerDefault: target,
    eventOverride: "primary",
  });
  const copy = await duplicateEvent(f.db, event.id, { ...details, slug: "copy" });
  assert.deepEqual(await getDestinationCalendars(f.db, copy.id), {
    ownerDefault: target,
    eventOverride: "primary",
  });
  const fallback = await duplicateEvent(f.db, "default", { ...details, slug: "fallback" });
  assert.equal((await getDestinationCalendars(f.db, fallback.id)).eventOverride, null);
  await f.send(`/api/owner/events/${event.id}`, { ...details, title: "Renamed" }, f.ownerHeaders, "PATCH");
  await f.send(`/api/owner/events/${event.id}/visibility`, { hidden: true }, f.ownerHeaders, "PATCH");
  assert.equal((await getDestinationCalendars(f.db, event.id)).eventOverride, "primary");
  role = "reader";
  const unavailable = await (await f.request(path, { headers: f.ownerHeaders })).json();
  assert.equal(unavailable.ownerDefault, target);
  assert.ok(!unavailable.calendars.some((entry: { id: string }) => entry.id === target));
  assert.equal((await f.send(path, { calendarId: target }, f.ownerHeaders, "PATCH")).status, 400);
  status = 403;
  assert.equal((await f.send(path, { calendarId: target }, f.ownerHeaders, "PATCH")).status, 503);
  assert.equal((await getDestinationCalendars(f.db)).ownerDefault, target);
  assert.equal((await f.send(eventPath, { calendarId: null }, f.ownerHeaders, "PATCH")).status, 200);
  for (const id of ["default", event.id, copy.id, fallback.id])
    assert.equal(
      (
        await f.request(`/api/owner/events/${id}`, {
          method: "DELETE",
          headers: { ...f.ownerHeaders, Origin: f.env.PUBLIC_ORIGIN },
        })
      ).status,
      200
    );
  const page = await getOwnerEventData(new Request(f.env.PUBLIC_ORIGIN, { headers: f.ownerHeaders }), {
    env: f.env,
    calendar: f.calendar,
    now: f.now,
  });
  assert.equal(page?.mode.kind, "create");
  assert.equal(page?.destinations.ownerDefault, target);
  assert.equal((await f.send(path, { calendarId: null }, f.ownerHeaders, "PATCH")).status, 200);
  assert.equal((await getDestinationCalendars(f.db)).ownerDefault, "primary");
});

test("fresh creates fence raced destination provenance and retain organizer-global overlap across destinations", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const other = await createEvent(f.db, details);
  await saveDestinationCalendar(f.db, target, other.id);
  const input = { ...guest, requestKey: crypto.randomUUID(), start: f.now() + 9 * hour };
  const first = await f.send(`/api/events/${other.id}/bookings`, input);
  assert.equal(first.status, 201);
  const booking = await first.json();
  assert.equal(f.calendar.writes[0].calendarId, target);
  const overlap = await f.send("/api/bookings", { ...input, requestKey: crypto.randomUUID() });
  assert.equal(overlap.status, 409);
  assert.equal((await overlap.json()).error, "conflict");
  const before = f.calendar.busy.bind(f.calendar);
  for (const id of [undefined, other.id]) {
    let changed = false;
    f.calendar.busy = async (...args) => {
      if (!changed) {
        changed = true;
        await saveDestinationCalendar(f.db, "changed-calendar", id);
      }
      return before(...args);
    };
    const result = await f.send(id ? `/api/events/${id}/bookings` : "/api/bookings", {
      ...guest,
      requestKey: crypto.randomUUID(),
      start: f.now() + 12 * hour,
    });
    assert.equal(result.status, 409);
    assert.equal((await result.json()).error, "settings_changed");
  }
  assert.equal(f.calendar.writes.length, 1);
  const replay = await f.send(`/api/events/${other.id}/bookings`, input);
  assert.equal(replay.status, 201);
  assert.equal((await replay.json()).id, booking.id);
  for (const path of ["/api/public", `/api/events/${other.id}`, `/api/bookings/${booking.id}`]) {
    const response = await f.request(path, { headers: { Authorization: `Bearer ${booking.manageToken}` } });
    assert.ok(!JSON.stringify(await response.json()).includes(target));
  }
  for (const table of ["booking", "booking_command"]) {
    await assert.rejects(
      f.db.prepare(`UPDATE ${table} SET calendar_id='other'`).run(),
      /immutable_calendar|idempotency_mismatch/
    );
  }
  await assert.rejects(
    f.db
      .prepare(`INSERT INTO booking_command(id,request_key,booking_id,action,payload,expected_version,
    desired_json,settings_json,token_hash,occupied_start,occupied_end,precondition,due,event_id,event_schedule_id,resolved_schedule_id,calendar_id)
    SELECT 'forged','forged',booking_id,'cancel','{}',1,desired_json,settings_json,token_hash,occupied_start,occupied_end,
      'accepted',0,event_id,event_schedule_id,resolved_schedule_id,'primary' FROM booking_command WHERE booking_id=?`)
      .bind(booking.id)
      .run(),
    /calendar_mismatch/
  );
});

test("lost create, move and cancel acknowledgments recover in the frozen destination after defaults and overrides change", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  await saveDestinationCalendar(f.db, target);
  const input = { ...guest, requestKey: crypto.randomUUID(), start: f.now() + 9 * hour };
  f.calendar.cutAfter = "insert";
  const created = await (await f.send("/api/bookings", input)).json();
  assert.equal(created.status, "attention");
  await saveDestinationCalendar(f.db, "later-default");
  await saveDestinationCalendar(f.db, "later-override", "default");
  const headers = { Authorization: `Bearer ${created.manageToken}` };
  const retry = () => f.send(`/api/bookings/${created.id}/retry`, {}, headers);
  assert.equal((await (await retry()).json()).status, "confirmed");
  assert.equal(f.calendar.writes.length, 1);
  const move = {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: 1,
    start: input.start + 2 * hour,
  };
  f.calendar.cutAfter = "update";
  assert.equal(
    (await (await f.send(`/api/bookings/${created.id}`, move, headers)).json()).status,
    "attention"
  );
  await saveDestinationCalendar(f.db, null, "default");
  assert.equal((await (await retry()).json()).status, "confirmed");
  assert.equal((await (await f.send(`/api/bookings/${created.id}`, move, headers)).json()).version, 2);
  const cancel = { action: "cancel", requestKey: crypto.randomUUID(), version: 2 };
  f.calendar.cutAfter = "delete";
  assert.equal(
    (await (await f.send(`/api/bookings/${created.id}`, cancel, headers)).json()).status,
    "attention"
  );
  f.calendar.revoked.add(target);
  assert.equal(
    (await (await retry()).json()).status,
    "attention",
    "Missing event with revoked target retains holds"
  );
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM booking_reservation WHERE booking_id=?")
      .bind(created.id)
      .first("n"),
    1
  );
  f.calendar.revoked.delete(target);
  assert.equal((await (await retry()).json()).status, "cancelled");
  assert.deepEqual(
    f.calendar.writes.map(({ action, calendarId }) => ({ action, calendarId })),
    [
      { action: "insert", calendarId: target },
      { action: "update", calendarId: target },
      { action: "delete", calendarId: target },
    ]
  );
  const commands = await f.db
    .prepare("SELECT calendar_id,payload,desired_json,settings_json FROM booking_command")
    .all<{ calendar_id: string; payload: string; desired_json: string; settings_json: string }>();
  for (const command of commands.results) {
    assert.equal(command.calendar_id, target);
    for (const bytes of [command.payload, command.desired_json, command.settings_json])
      assert.ok(!bytes.includes(target));
  }
  assert.equal(
    (await f.send(`/api/bookings/${created.id}`, { ...cancel, calendarId: "primary" }, headers)).status,
    400
  );
});

test("destination migration preserves populated rowids and all legacy JSON bytes while defaulting frozen identities to primary", async (t) => {
  const f = await apiFixture({ legacyDestinations: true });
  t.after(f.close);
  const raw = '{ "event": {"raw":"\\ud800"}, "kept":true }';
  await f.db.prepare("UPDATE event_type SET json=? WHERE id='default'").bind(raw).run();
  await f.db
    .prepare(`INSERT INTO booking_command(id,request_key,booking_id,action,payload,expected_version,
    desired_json,settings_json,token_hash,occupied_start,occupied_end,precondition,due)
    VALUES('old','old','old','create',?,0,?,?, 'hash',0,1,'accepted',0)`)
    .bind(raw, raw, `{"event":${raw},"schedule":{},"conflictCalendarIds":[]}`)
    .run();
  await f.db
    .prepare(
      "INSERT INTO booking(id,version,state,token_hash,initial_json) VALUES('legacy',1,'active','hash',?)"
    )
    .bind(raw)
    .run();
  const tables = ["organizer_settings", "event_type", "booking", "booking_command"];
  const capture = () =>
    Promise.all(
      tables.map((table) =>
        f.db
          .prepare(`SELECT rowid,* FROM ${table}`)
          .all()
          .then(({ results }) => results)
      )
    );
  const before = await capture();
  await f.migrateDestinations();
  const after = await capture();
  for (const [index, rows] of after.entries()) {
    assert.deepEqual(
      rows.map(({ destination_calendar_id, calendar_id, owner_calendar_id, event_calendar_id, ...row }) => {
        if (index === 0) assert.equal(destination_calendar_id, "primary");
        if (index === 1) assert.equal(destination_calendar_id, null);
        if (index >= 2) assert.equal(calendar_id, "primary");
        if (index === 3) {
          assert.equal(owner_calendar_id, "primary");
          assert.equal(event_calendar_id, null);
        }
        return row;
      }),
      before[index]
    );
  }
});

test("real adapter and D1 recover every queued and lost-ack action through the exact frozen calendar HTTP path", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const google = createGoogleFixture(f.env.PUBLIC_ORIGIN);
  const entry = { id: target, summary: "Destination", accessRole: "writer" };
  google.calendars.push(entry);
  const ciphertext = await seal(
    await encryptionKey(f.env.TOKEN_ENCRYPTION_KEY),
    JSON.stringify({
      access: google.secrets[0],
      refresh: google.secrets[1],
      expiresAt: Date.now() + hour,
    }),
    "google:owner"
  );
  await f.db.prepare("UPDATE google_connection SET ciphertext=?").bind(ciphertext).run();
  const writes: string[] = [];
  const calendar = new GoogleCalendar(f.env, async (input, init) => {
    const url = new URL(String(input));
    if (init?.method !== "GET" && url.pathname.includes("/events")) writes.push(url.pathname);
    return google.fetch(new Request(input, init));
  });
  const service = new BookingService({ db: f.db, calendar, secret: f.env.TOKEN_ENCRYPTION_KEY, now: f.now });
  let serial = 0;
  for (const action of ["create", "reschedule", "cancel"] as const) {
    for (const execution of ["queued", "sent"] as const) {
      await saveDestinationCalendar(f.db, target);
      await saveDestinationCalendar(f.db, null, "default");
      const input = { ...guest, requestKey: crypto.randomUUID(), start: f.now() + (++serial * 4 + 9) * hour };
      const initial = action === "create" ? null : await service.create(input);
      if (execution === "queued") entry.accessRole = "none";
      else google.loseResponseAfter({ create: "insert", reschedule: "update", cancel: "delete" }[action]);
      const request = {
        action,
        requestKey: crypto.randomUUID(),
        version: 1,
        ...(action === "reschedule" ? { start: input.start + hour } : {}),
      };
      const pending = initial
        ? await service.change(initial.id, initial.manageToken ?? "", request)
        : await service.create(input);
      assert.equal(pending.status, "attention");
      const before = await f.db
        .prepare(
          "SELECT payload,settings_json,desired_json,calendar_id,execution FROM booking_command WHERE booking_id=? ORDER BY rowid DESC LIMIT 1"
        )
        .bind(pending.id)
        .first();
      assert.equal(before?.execution, execution);
      await saveDestinationCalendar(f.db, "changed-default");
      await saveDestinationCalendar(f.db, "changed-override", "default");
      if (action === "cancel" && execution === "sent") {
        entry.accessRole = "reader";
        assert.equal((await service.ownerRetry(pending.id)).status, "attention");
        assert.equal(
          await f.db
            .prepare("SELECT count(*) AS n FROM booking_reservation WHERE booking_id=?")
            .bind(pending.id)
            .first("n"),
          1
        );
      }
      entry.accessRole = "writer";
      const completed = await service.ownerRetry(pending.id);
      assert.equal(completed.status, action === "cancel" ? "cancelled" : "confirmed");
      const after = await f.db
        .prepare(
          "SELECT payload,settings_json,desired_json,calendar_id FROM booking_command WHERE booking_id=? ORDER BY rowid DESC LIMIT 1"
        )
        .bind(pending.id)
        .first();
      const { execution: _execution, ...frozen } = before ?? {};
      assert.deepEqual(after, frozen);
      assert.equal(
        google.writes.filter(
          (write: { id: string; action: string }) =>
            write.id === pending.id &&
            write.action === { create: "insert", reschedule: "update", cancel: "delete" }[action]
        ).length,
        1
      );
    }
  }
  assert.ok(writes.length > 0);
  assert.ok(
    writes.every((path) => path.startsWith(`/calendar/v3/calendars/${encodeURIComponent(target)}/events`))
  );
  assert.deepEqual(google.denied, []);
});
