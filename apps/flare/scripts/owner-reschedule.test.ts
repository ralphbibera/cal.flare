import assert from "node:assert/strict";
import { test } from "node:test";
import { BookerClient, type ChangeRequest } from "../src/client/bookings.ts";
import { snapshot } from "../src/server/booking-model.ts";
import { BookingService } from "../src/server/bookings.ts";
import { record } from "../src/server/http.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

function ownerClient(f: Awaited<ReturnType<typeof apiFixture>>) {
  return new BookerClient((path, init) => {
    assert.equal(new Headers(init.headers).has("Authorization"), false);
    return f.request(path, {
      ...init,
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        ...f.ownerHeaders,
        Origin: f.env.PUBLIC_ORIGIN,
      },
    });
  });
}

test("owner slots authenticate before decoding and retain bounded, read-only self exclusion", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const client = ownerClient(f),
    start = f.now() + 9 * hour;
  const created = record(
    await (
      await f.send("/api/bookings", {
        requestKey: crypto.randomUUID(),
        start,
        name: "Guest",
        email: "guest@example.test",
        timeZone: "UTC",
      })
    ).json()
  );
  const id = String(created.id),
    path = `/api/owner/bookings/${id}`;
  const other = record(
    await (
      await f.send("/api/bookings", {
        requestKey: crypto.randomUUID(),
        start: start + hour / 2,
        name: "Other",
        email: "other@example.test",
        timeZone: "UTC",
      })
    ).json()
  );
  let reads = 0;
  const busy = f.calendar.busy.bind(f.calendar);
  f.calendar.busy = (...args) => {
    reads++;
    return busy(...args);
  };
  const denied = async (headers: Record<string, string>) => {
    assert.equal((await f.request("/api/owner/bookings/bad/slots?from=bad", { headers })).status, 401);
    assert.equal(
      (
        await f.request("/api/owner/bookings/bad", {
          method: "POST",
          headers: { ...headers, Origin: f.env.PUBLIC_ORIGIN },
          body: "bad",
        })
      ).status,
      401
    );
  };
  for (const headers of [
    {},
    { Cookie: `flare_session=${"A".repeat(43)}` },
    { Authorization: `Bearer ${created.manageToken}` },
  ])
    await denied(headers);
  await f.db.prepare("UPDATE owner_session SET expires_at=0").run();
  await denied(f.ownerHeaders);
  await f.db
    .prepare("UPDATE owner_session SET expires_at=?")
    .bind(Date.now() + hour)
    .run();
  const rows = async () =>
    Promise.all(
      ["booking", "booking_command", "booking_reservation", "organizer_settings"].map(
        async (table) => (await f.db.prepare(`SELECT * FROM ${table} ORDER BY rowid`).all()).results
      )
    );
  const before = await rows(),
    writes = f.calendar.writes.length;
  const query = { from: start, to: start + hour, timeZone: "Asia/Manila" };
  assert.ok((await client.ownerSlots(id, query)).some((slot) => slot.start === start));
  const params = new URLSearchParams({
    from: new Date(start).toISOString(),
    to: new Date(start + hour).toISOString(),
    timeZone: "UTC",
  });
  assert.equal(
    (await f.request(`/api/slots?${params}&bookingId=${id}`, { headers: f.ownerHeaders })).status,
    401
  );
  const response = await f.request(`${path}/slots?${params}`, { headers: f.ownerHeaders });
  assert.equal(response.headers.get("cache-control"), "no-store");
  for (const suffix of ["&owner=true", "&bookingId=" + id, "&from=bad", "&timeZone=UTC"])
    assert.equal(
      (await f.request(`${path}/slots?${params}${suffix}`, { headers: f.ownerHeaders })).status,
      400
    );
  for (const [key, value] of [
    ["from", ""],
    ["from", "2030"],
    ["to", new Date(start + 64 * 24 * hour).toISOString()],
    ["timeZone", "bad"],
  ]) {
    const invalid = new URLSearchParams(params);
    invalid.set(key, value);
    assert.equal((await f.request(`${path}/slots?${invalid}`, { headers: f.ownerHeaders })).status, 400);
  }
  assert.equal(reads, 2);
  const horizon = f.now() + 365 * 24 * hour;
  await client.ownerSlots(id, { from: horizon - hour, to: horizon, timeZone: "UTC" });
  await assert.rejects(
    client.ownerSlots(id, { from: horizon - hour, to: horizon + 1, timeZone: "UTC" }),
    /invalid_range/
  );
  assert.equal(reads, 3);
  const fold = await client.ownerSlots(id, {
    from: Date.parse("2030-11-03T01:00:00-04:00"),
    to: Date.parse("2030-11-03T02:00:00-05:00"),
    timeZone: "America/New_York",
  });
  for (const offset of ["-04:00", "-05:00"])
    assert.ok(fold.some((slot) => slot.start === Date.parse(`2030-11-03T01:30:00${offset}`)));
  const remote = f.calendar.events.get(id);
  assert.ok(remote);
  f.calendar.events.set("external", { ...remote, id: "external" });
  assert.equal(
    (await client.ownerSlots(id, query)).some((slot) => slot.start === start),
    false
  );
  f.calendar.events.delete("external");
  f.calendar.events.delete(String(other.id));
  assert.equal(
    (await client.ownerSlots(id, query)).some((slot) => slot.start === start + hour / 2),
    false
  );
  await f.db.prepare("DELETE FROM booking_reservation WHERE booking_id=?").bind(other.id).run();
  await f.db
    .prepare("INSERT INTO booking_reservation VALUES (?, 'candidate', ?, ?)")
    .bind(other.id, start + hour / 2, start + hour)
    .run();
  assert.equal(
    (await client.ownerSlots(id, query)).some((slot) => slot.start === start + hour / 2),
    false
  );
  await f.db.prepare("DELETE FROM booking_reservation WHERE booking_id=?").bind(other.id).run();
  await f.db
    .prepare("INSERT INTO booking_reservation VALUES (?, 'current', ?, ?)")
    .bind(other.id, start + hour / 2, start + hour)
    .run();
  assert.deepEqual(await rows(), before);
  assert.equal(f.calendar.writes.length, writes);
  for (const policy of [
    { ...settings, event: { ...settings.event, noticeMinutes: 600 } },
    { ...settings, event: { ...settings.event, afterMinutes: 15 } },
    { ...settings, schedule: { ...settings.schedule, overrides: [{ date: "2030-01-01", ranges: [] }] } },
  ]) {
    await f.send("/api/owner", policy, f.ownerHeaders, "PUT");
    assert.deepEqual(await client.ownerSlots(id, query), []);
  }
  await f.db.prepare("UPDATE http_rate SET n=60 WHERE key LIKE 'slots:%' AND key <> 'slots:all'").run();
  await assert.rejects(client.ownerSlots(id, query), /too_many_requests/);
  const finalReads = reads;
  await f.db.prepare("DELETE FROM owner_session").run();
  await denied(f.ownerHeaders);
  assert.equal(reads, finalReads);
});

test("owner moves preserve stored facts and canonical optional reasons after event edits", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const client = ownerClient(f),
    start = f.now() + 9 * hour;
  const created = record(
    await (
      await f.send("/api/bookings", {
        requestKey: crypto.randomUUID(),
        start,
        name: "Guest",
        email: "guest@example.test",
        timeZone: "Asia/Kolkata",
        notes: "Literal <notes>",
        guests: ["friend@example.test"],
      })
    ).json()
  );
  const id = String(created.id),
    path = `/api/owner/bookings/${id}`;
  const original = await f.db
    .prepare("SELECT confirmed_json FROM booking WHERE id=?")
    .bind(id)
    .first<string>("confirmed_json");
  assert.ok(original);
  const remote = f.calendar.events.get(id);
  assert.ok(remote);
  f.calendar.events.set(id, {
    ...remote,
    attendees: [...remote.attendees, { email: "friend@example.test" }],
  });
  await f.send(
    "/api/owner",
    { ...settings, event: { ...settings.event, durationMinutes: 60, title: "Edited" } },
    f.ownerHeaders,
    "PUT"
  );
  assert.deepEqual(await client.ownerSlots(id, { from: start, to: start + hour / 2, timeZone: "UTC" }), [
    { start, end: start + hour / 2 },
  ]);
  const move: Extract<ChangeRequest, { action: "reschedule" }> = {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: 1,
    start: start + hour,
    rescheduleReason: `  ${"😀".repeat(500)}  `,
  };
  for (const extra of [
    { owner: true },
    { cancellationReason: "wrong action" },
    { rescheduleReason: 1 },
    { rescheduleReason: "x".repeat(1001) },
  ])
    assert.equal((await f.send(path, { ...move, ...extra }, f.ownerHeaders)).status, 400);
  assert.equal((await f.send(path, move, { ...f.ownerHeaders, Origin: "https://foreign.test" })).status, 403);
  const moved = await client.ownerReschedule(id, move);
  assert.equal(moved.id, id);
  assert.equal(moved.title, settings.event.title);
  assert.equal(moved.timeZone, "Asia/Kolkata");
  assert.equal(moved.email, created.email);
  assert.equal(moved.end - moved.start, hour / 2);
  assert.equal(moved.rescheduleReason, "😀".repeat(500));
  const command = await f.db
    .prepare("SELECT payload,desired_json,id FROM booking_command WHERE request_key=?")
    .bind(move.requestKey)
    .first<{ payload: string; desired_json: string; id: string }>();
  assert.ok(command);
  assert.equal(
    command.payload,
    JSON.stringify({
      action: "reschedule",
      id,
      requestKey: move.requestKey,
      version: 1,
      start: move.start,
      rescheduleReason: "😀".repeat(500),
    })
  );
  const stored = snapshot(original);
  assert.deepEqual(snapshot(command.desired_json), {
    ...stored,
    start: move.start,
    end: move.start + hour / 2,
    privateMetadata: { ...stored.privateMetadata, operation: command.id },
  });
  assert.ok(!command.desired_json.includes("rescheduleReason"));
  const current = f.calendar.events.get(id);
  assert.ok(current);
  f.calendar.events.set(id, {
    ...current,
    attendees: [...current.attendees, { email: "friend@example.test" }],
  });
  const blank = {
    ...move,
    requestKey: crypto.randomUUID(),
    version: 2,
    start: start + 2 * hour,
    rescheduleReason: " \n\t ",
  };
  assert.equal((await client.ownerReschedule(id, blank)).rescheduleReason, undefined);
  const payload = await f.db
    .prepare("SELECT payload FROM booking_command WHERE request_key=?")
    .bind(blank.requestKey)
    .first<string>("payload");
  assert.equal(
    payload,
    JSON.stringify({ action: "reschedule", id, requestKey: blank.requestKey, version: 2, start: blank.start })
  );
  await assert.rejects(client.ownerReschedule(id, { ...blank, requestKey: crypto.randomUUID() }), /stale/);
  for (const value of [
    { ...moved, id: "b".repeat(64) },
    { ...moved, manageToken: created.manageToken },
  ])
    await assert.rejects(
      new BookerClient(async () => Response.json(value)).ownerReschedule(id, move),
      /invalid_response/
    );
  await assert.rejects(
    new BookerClient(async () => Response.json({ slots: [{ start, end: start }] })).ownerSlots(id, {
      from: start,
      to: start + hour,
      timeZone: "UTC",
    }),
    /invalid_response/
  );
});

test("owner fresh policy gates do not interfere with accepted uncertain moves or explicit recovery", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const client = ownerClient(f),
    start = f.now() + 9 * hour;
  const created = record(
    await (
      await f.send("/api/bookings", {
        requestKey: crypto.randomUUID(),
        start,
        name: "Guest",
        email: "guest@example.test",
        timeZone: "UTC",
      })
    ).json()
  );
  const id = String(created.id),
    query = { from: start, to: start + 3 * hour, timeZone: "UTC" };
  const move: Extract<ChangeRequest, { action: "reschedule" }> = {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: 1,
    start: start + hour,
    rescheduleReason: "  First\r\n<literal>  ",
  };
  const disabledSettings = { ...settings, event: { ...settings.event, disableRescheduling: true } };
  const service = (now: number, disabled = false) =>
    new BookingService({
      db: f.db,
      calendar: f.calendar,
      settings: disabled ? disabledSettings : settings,
      secret: f.env.TOKEN_ENCRYPTION_KEY,
      now: () => now,
    });
  await f.send("/api/owner", disabledSettings, f.ownerHeaders, "PUT");
  await assert.rejects(
    service(f.now(), true).ownerAvailability(id, query.from, query.to, query.timeZone),
    /invalid_slot/
  );
  await assert.rejects(
    service(f.now(), true).ownerChange(id, { ...move, requestKey: crypto.randomUUID() }),
    /invalid_slot/
  );
  await f.send("/api/owner", settings, f.ownerHeaders, "PUT");
  const late = service(start + hour);
  await assert.rejects(late.ownerAvailability(id, query.from, query.to, query.timeZone), /invalid_slot/);
  await assert.rejects(
    late.ownerChange(id, { ...move, requestKey: crypto.randomUUID(), start: start + 2 * hour }),
    /invalid_slot/
  );
  assert.ok(
    (await service(start + hour / 4).ownerAvailability(id, query.from, query.to, query.timeZone)).length > 0
  );
  const remote = f.calendar.events.get(id);
  assert.ok(remote);
  f.calendar.events.set(id, { ...remote, summary: "Externally changed" });
  assert.equal((await client.ownerReschedule(id, move)).status, "attention");
  const commands = (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results;
  await assert.rejects(client.ownerSlots(id, query), /busy/);
  assert.equal((await client.ownerView(id)).status, "attention");
  assert.deepEqual(
    (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
    commands
  );
  await assert.rejects(client.ownerReschedule(id, { ...move, requestKey: crypto.randomUUID() }), /busy/);
  f.calendar.events.set(id, remote);
  f.calendar.cutAfter = "update";
  assert.equal((await client.ownerReschedule(id, move)).status, "attention");
  const writes = f.calendar.writes.length;
  const recovered = await service(start + 48 * hour, true).ownerRetry(id);
  assert.equal(recovered.status, "confirmed");
  assert.equal(recovered.start, move.start);
  assert.equal(recovered.rescheduleReason, "First\r\n<literal>");
  assert.deepEqual(await service(start + 48 * hour, true).ownerChange(id, move), recovered);
  assert.equal(f.calendar.writes.length, writes);
  assert.equal(await f.db.prepare("SELECT count(*) FROM booking").first("count(*)"), 1);
  assert.equal(
    await f.db.prepare("SELECT count(*) FROM booking_command WHERE outcome='accepted'").first("count(*)"),
    2
  );
  assert.deepEqual((await f.db.prepare("SELECT start,end FROM booking_reservation").all()).results, [
    { start: move.start, end: move.start + hour / 2 },
  ]);
  await client.ownerCancel(id, {
    action: "cancel",
    version: 2,
    requestKey: crypto.randomUUID(),
    cancellationReason: "Required",
  });
  await assert.rejects(client.ownerSlots(id, query), /invalid_slot/);
  await assert.rejects(
    client.ownerReschedule(id, { ...move, version: 3, requestKey: crypto.randomUUID() }),
    /invalid_state/
  );
  assert.equal((await client.ownerView(id)).status, "cancelled");
});

test("attendee notice uses the current original start while frozen moves and owner projections retain their rights", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  let clock = f.now();
  const service = new BookingService({
    db: f.db,
    calendar: f.calendar,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: () => clock,
  });
  const start = clock + 9 * hour;
  const create = {
    requestKey: crypto.randomUUID(),
    start,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "America/New_York",
  };
  const booking = await service.create(create);
  const token = String(booking.manageToken),
    id = booking.id;
  const rules = {
    intervalMinutes: 30,
    beforeMinutes: 0,
    afterMinutes: 0,
    noticeMinutes: 0,
    disableCancelling: false,
    disableRescheduling: false,
  };
  const policy = async (notice: number | null, always = false) => {
    assert.equal(
      (
        await f.send(
          "/api/owner/events/default/booking-rules",
          { ...rules, disableRescheduling: always, minimumRescheduleNotice: notice },
          f.ownerHeaders,
          "PATCH"
        )
      ).status,
      200
    );
  };
  await policy(60);
  for (const [delta, blocked] of [
    [hour, false],
    [hour - 1, true],
    [hour + 1, false],
    [0, false],
    [-1, false],
  ] as const) {
    clock = start - delta;
    assert.equal((await service.view(id, token)).disableRescheduling, blocked);
    assert.equal((await service.ownerView(id)).disableRescheduling, false);
    assert.equal((await service.ownerList())[0].disableRescheduling, false);
    assert.equal(
      (await service.ownerPage({ filter: "all", before: null })).bookings[0].disableRescheduling,
      false
    );
  }
  clock = start - hour;
  assert.ok((await service.availability(start, start + hour, "UTC", { id, token })).length);
  const remote = f.calendar.events.get(id);
  assert.ok(remote);
  f.calendar.events.set(id, { ...remote, summary: "Changed outside the app" });
  const move = { action: "reschedule", requestKey: crypto.randomUUID(), version: 1, start: start + hour };
  assert.equal((await service.change(id, token, move)).status, "attention");
  const frozen = await f.db
    .prepare("SELECT payload,settings_json,desired_json FROM booking_command WHERE request_key=?")
    .bind(move.requestKey)
    .first();
  assert.ok(frozen);
  await policy(1440);
  clock = start - 1;
  assert.equal(
    (await service.change(id, token, move)).status,
    "attention",
    "Queued replay does not reauthorize notice"
  );
  f.calendar.events.set(id, remote);
  f.calendar.cutAfter = "update";
  assert.equal((await service.change(id, token, move)).status, "attention");
  const applied = f.calendar.writes.length;
  await f.db.prepare("UPDATE event_type SET json='{}' WHERE id='default'").run();
  assert.equal(
    (await service.retry(id, token)).status,
    "confirmed",
    "Sent replay uses frozen policy even when current policy is corrupt"
  );
  assert.equal((await service.create(create)).manageToken, token);
  assert.equal((await service.change(id, token, move)).start, move.start);
  assert.equal(f.calendar.writes.length, applied);
  assert.deepEqual(
    await f.db
      .prepare("SELECT payload,settings_json,desired_json FROM booking_command WHERE request_key=?")
      .bind(move.requestKey)
      .first(),
    frozen
  );
  assert.equal(
    String(frozen.payload),
    JSON.stringify({ action: "reschedule", id, requestKey: move.requestKey, version: 1, start: move.start })
  );
  await f.db
    .prepare("UPDATE event_type SET json=? WHERE id='default'")
    .bind(JSON.stringify(settings.event))
    .run();
  await policy(60);
  clock = move.start - hour + 1;
  const stalePage = { ...move, version: 2, requestKey: crypto.randomUUID(), start: move.start + hour };
  const holds = (await f.db.prepare("SELECT * FROM booking_reservation").all()).results;
  let reads = 0;
  const busy = f.calendar.busy.bind(f.calendar);
  f.calendar.busy = (...args) => {
    reads++;
    return busy(...args);
  };
  await assert.rejects(service.change(id, token, stalePage), /invalid_slot/);
  await assert.rejects(
    service.availability(move.start, move.start + 2 * hour, "UTC", { id, token }),
    /invalid_slot/
  );
  assert.equal(reads, 0);
  assert.equal(f.calendar.writes.length, applied);
  assert.deepEqual((await f.db.prepare("SELECT * FROM booking_reservation").all()).results, holds);
  await policy(null);
  await assert.rejects(service.change(id, token, stalePage), /invalid_slot/);
  await policy(1440);
  assert.ok((await service.ownerAvailability(id, move.start, move.start + 2 * hour, "UTC")).length);
  const ownerMove = { ...stalePage, requestKey: crypto.randomUUID() };
  const moved = await service.ownerChange(id, ownerMove);
  assert.equal(moved.disableRescheduling, false);
  assert.equal(moved.end - moved.start, hour / 2);
  assert.equal((await service.ownerChange(id, ownerMove)).disableRescheduling, false);
  assert.equal((await service.change(id, token, ownerMove)).disableRescheduling, true);
  assert.equal((await service.ownerRetry(id)).disableRescheduling, false);
  assert.equal((await service.retry(id, token)).disableRescheduling, true);
  const writes = f.calendar.writes.length;
  await policy(0);
  f.calendar.busy = async (...args) => {
    await policy(1440);
    return busy(...args);
  };
  await assert.rejects(
    service.change(id, token, {
      ...ownerMove,
      version: 3,
      requestKey: crypto.randomUUID(),
      start: ownerMove.start + hour,
    }),
    /settings_changed/
  );
  assert.equal(f.calendar.writes.length, writes);
  f.calendar.busy = busy;
  await policy(60, true);
  await assert.rejects(
    service.ownerChange(id, { ...ownerMove, version: 3, requestKey: crypto.randomUUID() }),
    /invalid_slot/
  );
  await policy(60);
  await f.db.prepare("UPDATE event_type SET lifecycle='removed' WHERE id='default'").run();
  await assert.rejects(service.ownerAvailability(id, start, start + 4 * hour, "UTC"), /invalid_slot/);
  await assert.rejects(
    service.ownerChange(id, { ...ownerMove, version: 3, requestKey: crypto.randomUUID() }),
    /invalid_slot/
  );
});
