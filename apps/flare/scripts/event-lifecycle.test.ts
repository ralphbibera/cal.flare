import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient } from "../src/client/bookings.ts";
import { getOwnerBookings, getOwnerEventData } from "../src/server/app.ts";
import { BookingService } from "../src/server/bookings.ts";
import { GoogleCalendarError } from "../src/server/google.ts";
import {
  duplicateEvent,
  getSettings,
  removeEvent,
  saveBookingRules,
  saveEventDetails,
  saveSettings,
} from "../src/server/settings.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

const details = { title: "Copied", slug: "copied", description: "Literal <copy>", durationMinutes: 45 };
const input = (start: number) => ({
  requestKey: crypto.randomUUID(),
  start,
  name: "Guest",
  email: "guest@example.test",
  timeZone: "UTC",
});
async function read(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get("cache-control"), "no-store");
  return response.json();
}
function service(f: Awaited<ReturnType<typeof apiFixture>>) {
  return new BookingService({
    db: f.db,
    calendar: f.calendar,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: f.now,
  });
}
function remove(f: Awaited<ReturnType<typeof apiFixture>>, id = "default") {
  return f.request(`/api/owner/events/${id}`, {
    method: "DELETE",
    headers: { ...f.ownerHeaders, Origin: f.env.PUBLIC_ORIGIN },
  });
}
const rows = async (f: Awaited<ReturnType<typeof apiFixture>>) =>
  Promise.all([
    f.db.prepare("SELECT rowid AS cursor,* FROM event_type ORDER BY rowid").all(),
    f.db.prepare("SELECT * FROM organizer_settings").all(),
    f.db.prepare("SELECT rowid AS cursor,* FROM booking ORDER BY rowid").all(),
    f.db.prepare("SELECT rowid AS cursor,* FROM booking_command ORDER BY rowid").all(),
    f.db.prepare("SELECT * FROM booking_reservation ORDER BY booking_id,role").all(),
  ]).then((results) => results.map((result) => result.results));

test("lifecycle API hides direct-bookable events and retains permanent tombstones", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const path = "/api/owner/events/default";
  assert.equal((await f.send(`${path}/visibility`, { hidden: true }, f.ownerHeaders, "PATCH")).status, 200);
  assert.equal((await f.request("/api/public")).status, 200);
  const query = new URLSearchParams({
    from: new Date(f.now() + 9 * hour).toISOString(),
    to: new Date(f.now() + 10 * hour).toISOString(),
    timeZone: "UTC",
  });
  assert.ok((await read(await f.request(`/api/events/default/slots?${query}`))).slots.length > 0);
  const input = {
    requestKey: crypto.randomUUID(),
    start: f.now() + 9 * hour,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
  };
  const accepted = await f.send("/api/bookings", input);
  assert.equal(accepted.status, 201);
  assert.equal(
    (await f.request(path, { method: "DELETE", headers: { ...f.ownerHeaders, Origin: f.env.PUBLIC_ORIGIN } }))
      .status,
    200
  );
  assert.equal((await f.request("/api/public")).status, 404);
  assert.equal((await f.request(`/api/slots?${query}`)).status, 404);
  assert.equal((await f.send("/api/bookings", input)).status, 201);
  assert.equal((await f.send("/api/bookings", { ...input, requestKey: crypto.randomUUID() })).status, 404);
  assert.equal(f.calendar.writes.length, 1);
});

test("duplication atomically copies saved private configuration and visibility with independent identity", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const saved = {
    ...settings,
    event: {
      ...settings.event,
      location: "Private\ud800\u0000東京 😀",
      bookingWindowDays: 30,
      disableCancelling: true,
      disableRescheduling: false,
      intervalMinutes: 15,
      beforeMinutes: 10,
      afterMinutes: 20,
      noticeMinutes: 60,
    },
  };
  await saveSettings(f.db, saved);
  const before = await rows(f);
  for (const hidden of [true, true, false, false, true]) {
    await read(await f.send("/api/owner/events/default/visibility", { hidden }, f.ownerHeaders, "PATCH"));
    const current = await rows(f);
    assert.deepEqual(
      current[0].map(({ lifecycle: _lifecycle, ...row }) => row),
      before[0].map(({ lifecycle: _lifecycle, ...row }) => row)
    );
    assert.deepEqual(current.slice(1), before.slice(1));
  }
  const copied = await read(
    await f.send("/api/owner/events/default/duplicate", details, f.ownerHeaders),
    201
  );
  assert.notEqual(copied.id, "default");
  assert.equal(copied.lifecycle, "hidden");
  assert.deepEqual(copied.event, { ...saved.event, ...details });
  await saveEventDetails(f.db, { ...details, title: "Edited copy" }, copied.id);
  assert.deepEqual(await getSettings(f.db), saved);
  const races = await Promise.all(
    [0, 1].map(() =>
      f.send("/api/owner/events/default/duplicate", { ...details, slug: "raced-copy" }, f.ownerHeaders)
    )
  );
  assert.deepEqual(races.map((r) => r.status).sort(), [201, 409]);
  const client = new BookerClient((path, init) => f.request(path, { ...init, headers: f.ownerHeaders }));
  assert.equal((await client.ownerEvents()).find((e) => e.id === copied.id)?.lifecycle, "hidden");
  const db = {
    batch: f.db.batch.bind(f.db),
    prepare: (sql: string) => {
      const statement = f.db.prepare(sql);
      if (!sql.startsWith("INSERT INTO event_type")) return statement;
      return new Proxy(statement, {
        get(target, key) {
          if (key !== "bind") return Reflect.get(target, key);
          return (...values: unknown[]) =>
            new Proxy(target.bind(...values), {
              get(bound, key) {
                if (key !== "run") return Reflect.get(bound, key);
                return async () => {
                  await removeEvent(f.db, "default");
                  return bound.run();
                };
              },
            });
        },
      });
    },
  };
  await assert.rejects(duplicateEvent(db, "default", { ...details, slug: "late-copy" }), /not_found/);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM event_type WHERE json_extract(json,'$.slug')='late-copy'")
      .first("n"),
    0
  );
  assert.equal(f.calendar.writes.length, 0);
});

test("removed default and final event preserve owner entry, shared preferences, history and immutable legacy routing", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const b = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  const booking = await service(f).create(input(f.now() + 9 * hour));
  await read(await remove(f));
  const dependencies = { env: f.env, calendar: f.calendar, now: f.now };
  const page = (query = "", headers: HeadersInit = f.ownerHeaders) =>
    getOwnerEventData(new Request(`${f.env.PUBLIC_ORIGIN}/${query}`, { headers }), dependencies);
  assert.equal((await page())?.selectedId, b.id);
  for (const id of ["default", crypto.randomUUID()]) {
    await assert.rejects(page(`?eventId=${id}`), /not_found/);
    assert.equal(await page(`?eventId=${id}`, {}), null);
  }
  const stable = await rows(f);
  const replacement = { ...settings, schedule: { ...settings.schedule, timeZone: "Asia/Tokyo" } };
  await read(await f.send("/api/owner", replacement, f.ownerHeaders, "PUT"), 404);
  await assert.rejects(saveSettings(f.db, replacement), /not_found/);
  await assert.rejects(saveEventDetails(f.db, details), /not_found/);
  await assert.rejects(
    saveBookingRules(f.db, {
      intervalMinutes: 30,
      beforeMinutes: 0,
      afterMinutes: 0,
      noticeMinutes: 0,
      disableCancelling: false,
      disableRescheduling: false,
    }),
    /not_found/
  );
  assert.deepEqual(await rows(f), stable);
  for (const path of ["/api/public", "/api/events/default", "/api/owner/events/default"])
    await read(await f.request(path, { headers: f.ownerHeaders }), 404);
  await read(await f.send("/api/bookings", input(f.now() + 12 * hour)), 404);
  await read(await f.send("/api/owner/events", { ...details, slug: "intro" }, f.ownerHeaders), 409);
  await read(await remove(f, b.id));
  const empty = await page();
  assert.equal(empty?.creating, true);
  assert.deepEqual(empty?.events, []);
  assert.equal(empty?.bookings[0]?.id, booking.id);
  assert.equal(empty?.bookings[0]?.disableRescheduling, true);
  assert.equal((await page("?create=1"))?.creating, true);
  await read(
    await f.send(
      "/api/owner/schedule",
      { ...settings.schedule, timeZone: "Asia/Tokyo" },
      f.ownerHeaders,
      "PATCH"
    )
  );
  await read(await f.send("/api/owner/overrides", { overrides: [] }, f.ownerHeaders, "PATCH"));
  await read(
    await f.send("/api/owner/conflict-calendars", { conflictCalendarIds: [] }, f.ownerHeaders, "PATCH")
  );
  assert.equal(
    (
      await getOwnerBookings(
        new Request(`${f.env.PUBLIC_ORIGIN}/owner/bookings`, { headers: f.ownerHeaders }),
        dependencies
      )
    )?.timeZone,
    "Asia/Tokyo"
  );
  assert.equal(
    (await read(await f.request("/api/owner", { headers: f.ownerHeaders }))).settings.schedule.timeZone,
    "Asia/Tokyo"
  );
  await f.db.prepare("UPDATE availability_schedule SET json='{}'").run();
  await assert.rejects(page("?create=1"), /timeZone/);
  assert.equal(f.calendar.writes.length, 1);
});

test("hide cannot invalidate admission but removal races durably reject create and both actors' moves", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const s = service(f);
  const busy = f.calendar.busy.bind(f.calendar);
  f.calendar.busy = async (...args) => {
    f.calendar.busy = busy;
    await read(
      await f.send("/api/owner/events/default/visibility", { hidden: true }, f.ownerHeaders, "PATCH")
    );
    return busy(...args);
  };
  const booked = await s.create(input(f.now() + 9 * hour));
  assert.ok(booked.manageToken);
  const b = await read(
    await f.send("/api/owner/events", { ...details, slug: "race-b" }, f.ownerHeaders),
    201
  );
  await saveBookingRules(
    f.db,
    {
      intervalMinutes: 30,
      beforeMinutes: 0,
      afterMinutes: 0,
      noticeMinutes: 0,
      disableCancelling: false,
      disableRescheduling: false,
    },
    b.id
  );
  const raced = input(f.now() + 12 * hour);
  f.calendar.busy = async (...args) => {
    f.calendar.busy = busy;
    await read(await remove(f, b.id));
    return busy(...args);
  };
  await assert.rejects(s.create(raced, b.id), /invalid_slot/);
  const rejected = await f.db
    .prepare("SELECT * FROM booking_command WHERE request_key=?")
    .bind(raced.requestKey)
    .first();
  assert.equal(rejected?.outcome, "invalid_slot");
  assert.equal(
    await f.db.prepare("SELECT count(*) AS n FROM booking WHERE event_id=?").bind(b.id).first("n"),
    0
  );
  assert.equal(await f.db.prepare("SELECT count(*) AS n FROM booking_reservation").first("n"), 1);
  await assert.rejects(s.create(raced, b.id), /invalid_slot/);
  const move = {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: 1,
    start: f.now() + 15 * hour,
  };
  f.calendar.busy = async (...args) => {
    f.calendar.busy = busy;
    await read(await remove(f));
    return busy(...args);
  };
  await assert.rejects(s.change(booked.id, booked.manageToken, move), /invalid_slot/);
  for (const actor of ["owner", "attendee"]) {
    const next = { ...move, requestKey: crypto.randomUUID() };
    const writes = f.calendar.writes.length;
    let reads = 0;
    f.calendar.busy = async (...args) => {
      reads++;
      return busy(...args);
    };
    await assert.rejects(
      actor === "owner" ? s.ownerChange(booked.id, next) : s.change(booked.id, booked.manageToken, next),
      /invalid_slot/
    );
    assert.equal(reads, 0);
    assert.equal(f.calendar.writes.length, writes);
  }
  assert.equal((await s.ownerView(booked.id)).disableRescheduling, true);
  await assert.rejects(
    s.ownerChange(booked.id, { action: "cancel", requestKey: crypto.randomUUID(), version: 1 }),
    /invalid_input/
  );
  const cancelled = await s.ownerChange(booked.id, {
    action: "cancel",
    requestKey: crypto.randomUUID(),
    version: 1,
    cancellationReason: "Owner removed the event",
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal(cancelled.cancellationReason, "Owner removed the event");
});

for (const action of ["create", "reschedule", "cancel"] as const) {
  test(`removed events retain queued and sent ${action} recovery, command bytes and provider identity`, async (t) => {
    const f = await apiFixture();
    t.after(f.close);
    const s = service(f);
    await saveSettings(f.db, { ...settings, conflictCalendarIds: [] });
    for (const [index, mode] of ["queued", "sent"].entries()) {
      const event = await read(
        await f.send(
          "/api/owner/events/default/duplicate",
          { ...details, slug: `${action}-${mode}` },
          f.ownerHeaders
        ),
        201
      );
      const data = input(f.now() + (9 + index * 5) * hour);
      const booking = action === "create" ? null : await s.create(data, event.id);
      const operation = ({ create: "insert", reschedule: "update", cancel: "delete" } as const)[action];
      const insert = f.calendar.insert.bind(f.calendar);
      const update = f.calendar.update.bind(f.calendar);
      const cancel = f.calendar.delete.bind(f.calendar);
      const get = f.calendar.get.bind(f.calendar);
      if (mode === "queued") {
        const fail = async () => {
          throw new GoogleCalendarError("retryable", 429, "Not applied");
        };
        if (action === "create") f.calendar.insert = fail;
        else f.calendar.get = fail;
      } else f.calendar.cutAfter = operation;
      const change = {
        action,
        requestKey: crypto.randomUUID(),
        version: 1,
        ...(action === "reschedule"
          ? { start: data.start + 2 * hour, rescheduleReason: "Move" }
          : { cancellationReason: "Cancel" }),
      };
      const pending =
        action === "create"
          ? await s.create(data, event.id)
          : await s.ownerChange(String(booking?.id), change);
      assert.equal(pending.status, "attention");
      const key = action === "create" ? data.requestKey : change.requestKey;
      const command = await f.db
        .prepare("SELECT * FROM booking_command WHERE request_key=?")
        .bind(key)
        .first();
      assert.equal(command?.execution, mode);
      const held = (await f.db.prepare("SELECT * FROM booking_reservation ORDER BY booking_id,role").all())
        .results;
      const writes = f.calendar.writes.length;
      await read(await remove(f, event.id));
      assert.deepEqual(
        (await f.db.prepare("SELECT * FROM booking_reservation ORDER BY booking_id,role").all()).results,
        held
      );
      assert.deepEqual(
        await f.db.prepare("SELECT * FROM booking_command WHERE request_key=?").bind(key).first(),
        command
      );
      assert.equal((await s.ownerView(pending.id)).status, "attention");
      await s.ownerList();
      assert.equal(f.calendar.writes.length, writes);
      if (action !== "cancel") {
        await assert.rejects(s.create(input(data.start)), /conflict/);
        if (action === "reschedule") await assert.rejects(s.create(input(data.start + 2 * hour)), /conflict/);
      }
      f.calendar.insert = insert;
      f.calendar.update = update;
      f.calendar.delete = cancel;
      f.calendar.get = get;
      await f.db
        .prepare("UPDATE booking_command SET due=0,lease_until=0 WHERE request_key=?")
        .bind(key)
        .run();
      await s.recover();
      const recovered = await s.ownerView(pending.id);
      assert.equal(recovered.status, action === "cancel" ? "cancelled" : "confirmed");
      assert.equal(f.calendar.writes.length, writes + (mode === "queued" ? 1 : 0));
      const replay =
        action === "create" ? await s.create(data, event.id) : await s.ownerChange(pending.id, change);
      assert.equal(replay.id, pending.id);
      if (action === "create") assert.equal(replay.manageToken, pending.manageToken);
      const current = await f.db
        .prepare("SELECT * FROM booking_command WHERE request_key=?")
        .bind(key)
        .first();
      for (const field of [
        "id",
        "booking_id",
        "event_id",
        "payload",
        "settings_json",
        "desired_json",
        "token_hash",
        "outcome",
        "occupied_start",
        "occupied_end",
      ])
        assert.equal(current?.[field], command?.[field]);
    }
  });
}

test("lifecycle endpoints enforce owner session, origin and strict bodies without leaking private state", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const stable = await rows(f);
  const operations = [
    { path: "/api/owner/events/default/duplicate", method: "POST", body: details },
    { path: "/api/owner/events/default/visibility", method: "PATCH", body: { hidden: true } },
    { path: "/api/owner/events/default", method: "DELETE", body: undefined },
  ];
  for (const operation of operations) {
    for (const headers of [
      {},
      { Authorization: `Bearer ${"a".repeat(43)}` },
      { Cookie: "flare_session=expired" },
    ]) {
      await read(await f.send(operation.path, operation.body, headers, operation.method), 401);
      await read(
        await f.send(`${operation.path}?eventId=other`, operation.body, headers, operation.method),
        401
      );
    }
    await read(
      await f.send(
        operation.path,
        operation.body,
        { ...f.ownerHeaders, Origin: "https://foreign.test" },
        operation.method
      ),
      403
    );
    await read(
      await f.send(
        `${operation.path}?id=default&id=default`,
        operation.body,
        f.ownerHeaders,
        operation.method
      ),
      400
    );
    await read(
      await f.send(
        operation.path.replace("default", crypto.randomUUID()),
        operation.body,
        f.ownerHeaders,
        operation.method
      ),
      404
    );
  }
  for (const value of [
    { hidden: "true" },
    { hidden: true, id: "default" },
    {},
    null,
    { lifecycle: "hidden" },
  ])
    await read(await f.send("/api/owner/events/default/visibility", value, f.ownerHeaders, "PATCH"), 400);
  for (const value of [
    { ...details, location: "replace" },
    { ...details, hidden: true },
    { title: "Missing" },
    null,
  ])
    await read(await f.send("/api/owner/events/default/duplicate", value, f.ownerHeaders), 400);
  await read(
    await f.send("/api/owner/events/default", { lifecycle: "hidden" }, f.ownerHeaders, "PATCH"),
    400
  );
  for (const value of [{}, { id: "default" }, null])
    await read(await f.send("/api/owner/events/default", value, f.ownerHeaders, "DELETE"), 400);
  assert.deepEqual(await rows(f), stable);
  await read(await remove(f));
  const tombstone = await rows(f);
  await read(await remove(f));
  await read(
    await f.send("/api/owner/events/default/visibility", { hidden: false }, f.ownerHeaders, "PATCH"),
    404
  );
  await read(await f.send("/api/owner/events/default/duplicate", details, f.ownerHeaders), 404);
  await assert.rejects(
    f.db.prepare("UPDATE event_type SET lifecycle='listed' WHERE id='default'").run(),
    /event_removed/
  );
  assert.deepEqual(await rows(f), tombstone);
  await f.db.prepare("UPDATE owner_session SET expires_at=0").run();
  await read(await remove(f), 401);
  assert.equal(f.calendar.writes.length, 0);
});

test("removed cancellation obeys policy and durable rejections while accepted creates replay across event context", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const s = service(f);
  await saveSettings(f.db, { ...settings, event: { ...settings.event, disableCancelling: true } });
  const data = input(f.now() + 9 * hour);
  const booked = await s.create(data);
  assert.ok(booked.manageToken);
  const rejected = input(data.start);
  await assert.rejects(s.create(rejected), /conflict/);
  const before = await rows(f);
  await read(await remove(f));
  const auth = { Authorization: `Bearer ${booked.manageToken}` };
  for (const owner of [true, false]) {
    const path = owner ? `/api/owner/bookings/${booked.id}` : `/api/bookings/${booked.id}`;
    const headers = owner ? f.ownerHeaders : auth;
    const change = {
      action: "cancel",
      requestKey: crypto.randomUUID(),
      version: 1,
      cancellationReason: "Still disabled",
    };
    const refusal = await read(await f.send(path, change, headers), 409);
    assert.equal(refusal.error, "invalid_slot");
    assert.deepEqual(await read(await f.send(path, change, headers), 409), refusal);
  }
  assert.equal(
    (await read(await f.request(`/api/bookings/${booked.id}`, { headers: auth }))).disableCancelling,
    true
  );
  assert.equal(
    (await read(await f.request(`/api/owner/bookings/${booked.id}`, { headers: f.ownerHeaders })))
      .disableRescheduling,
    true
  );
  await assert.rejects(s.ownerAvailability(booked.id, data.start, data.start + hour, "UTC"), /invalid_slot/);
  await assert.rejects(
    s.availability(data.start, data.start + hour, "UTC", { id: booked.id, token: booked.manageToken }),
    /not_found/
  );
  await f.db.prepare("UPDATE organizer_settings SET json='{\"unsupported\":true}'").run();
  const replay = await s.create(data);
  assert.equal(replay.id, booked.id);
  assert.equal(replay.manageToken, booked.manageToken);
  await assert.rejects(s.create(rejected), /conflict/);
  const otherId = crypto.randomUUID();
  await f.db
    .prepare("INSERT INTO event_type(id,json,version) VALUES (?,?,1)")
    .bind(otherId, JSON.stringify({ ...settings.event, slug: "other" }))
    .run();
  await assert.rejects(s.create(data, otherId), /idempotency_mismatch/);
  const after = await rows(f);
  assert.deepEqual(after[2], before[2]);
  assert.deepEqual(after[4], before[4]);
  for (const command of before[3])
    assert.deepEqual(
      after[3].find((row) => row.id === command.id),
      command
    );
  assert.equal(f.calendar.writes.length, 1);
});

test("concurrent full replacement and detail writes cannot revive a tombstone or partially save owner preferences", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const replacement = {
    ...settings,
    event: { ...settings.event, title: "Replacement" },
    schedule: { ...settings.schedule, timeZone: "Asia/Tokyo" },
  };
  const responses = await Promise.all([
    remove(f),
    f.send("/api/owner", replacement, f.ownerHeaders, "PUT"),
    f.send(
      "/api/owner",
      { title: "Detail race", slug: "intro", description: "", durationMinutes: 60 },
      f.ownerHeaders,
      "PATCH"
    ),
  ]);
  assert.equal(responses[0].status, 200);
  assert.ok([200, 404].includes(responses[1].status));
  assert.ok([200, 404].includes(responses[2].status));
  assert.equal(
    await f.db.prepare("SELECT lifecycle FROM event_type WHERE id='default'").first("lifecycle"),
    "removed"
  );
  const current = await getSettings(f.db);
  assert.equal(current.schedule.timeZone, responses[1].status === 200 ? "Asia/Tokyo" : "UTC");
  const frozen = await rows(f);
  await assert.rejects(saveSettings(f.db, settings), /not_found/);
  assert.deepEqual(await rows(f), frozen);
  assert.equal(f.calendar.writes.length, 0);
});
