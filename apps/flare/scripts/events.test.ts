import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings, parseSettings } from "../src/domain/settings.ts";
import { getOwnerEventData } from "../src/server/app.ts";
import { BookingService } from "../src/server/bookings.ts";
import { GoogleCalendarError } from "../src/server/google.ts";
import { ErrorWithCode } from "../src/server/http.ts";
import {
  findEventBySlug,
  getSettings,
  saveBookingRules,
  saveEventDetails,
  saveSettings,
} from "../src/server/settings.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

const details = { slug: "second-event", title: "Second event", description: "Event B", durationMinutes: 45 };
const rules = {
  intervalMinutes: 5,
  beforeMinutes: 0,
  afterMinutes: 0,
  noticeMinutes: 0,
  disableCancelling: false,
  disableRescheduling: false,
};
const input = (start: number) => ({
  requestKey: crypto.randomUUID(),
  start,
  name: "Guest B",
  email: "b@example.test",
  timeZone: "UTC",
  notes: "Historical notes",
  guests: ["other@example.test"],
});
async function read(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  return response.json();
}

test("owner page selection authenticates before query disclosure and never falls back from invalid IDs", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const b = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  const dependencies = { env: f.env, calendar: f.calendar, now: f.now };
  const page = (query: string, authorized = true) =>
    getOwnerEventData(
      new Request(`${f.env.PUBLIC_ORIGIN}/?${query}`, { headers: authorized ? f.ownerHeaders : {} }),
      dependencies
    );
  const selected = await page(`eventId=${b.id}`);
  assert.equal(selected?.selectedId, b.id);
  assert.deepEqual(selected?.settings.event, { ...defaultSettings.event, ...details });
  assert.deepEqual(selected?.settings.schedule, settings.schedule);
  assert.equal(selected?.creating, false);
  assert.equal((await page("create=1"))?.creating, true);
  for (const query of [
    "eventId=invalid",
    `eventId=${crypto.randomUUID()}`,
    "eventId=default&eventId=default",
    "eventId=default&create=1",
    "create=bad",
  ]) {
    assert.equal(await page(query, false), null);
    await assert.rejects(page(query), ErrorWithCode);
  }
  assert.equal(await findEventBySlug(f.db, details.slug), b.id);
  await saveEventDetails(f.db, { ...details, slug: "renamed-b" }, b.id);
  assert.equal(await findEventBySlug(f.db, details.slug), null);
  assert.equal(await findEventBySlug(f.db, "renamed-b"), b.id);
  const plan = await f.db
    .prepare("EXPLAIN QUERY PLAN SELECT id FROM event_type WHERE json_extract(json,'$.slug')=?")
    .bind("renamed-b")
    .all<{ detail: string }>();
  assert.ok(plan.results.some((row) => row.detail.includes("event_type_slug")));
  assert.equal(f.calendar.writes.length, 0);
});

test("owner creates a stable independently editable event through authenticated HTTP", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const created = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  assert.match(created.id, /^[0-9a-f-]{36}$/);
  assert.deepEqual(created.event, { ...defaultSettings.event, ...details });
  const path = `/api/owner/events/${created.id}`;
  assert.deepEqual(await read(await f.request(path, { headers: f.ownerHeaders })), created);
  assert.deepEqual(await read(await f.request("/api/owner/events", { headers: f.ownerHeaders })), {
    events: [{ id: "default", event: settings.event, lifecycle: "listed" }, created],
  });
  assert.deepEqual(await getSettings(f.db), settings);
  const location = "Room B\ud800\u0000東京 😀";
  await read(await f.send(path, { ...details, slug: "renamed-b", location }, f.ownerHeaders, "PATCH"));
  await read(
    await f.send(`${path}/booking-rules`, { ...rules, bookingWindowDays: 30 }, f.ownerHeaders, "PATCH")
  );
  const b = await getSettings(f.db, created.id);
  assert.deepEqual(b.event, {
    ...defaultSettings.event,
    ...details,
    slug: "renamed-b",
    ...rules,
    bookingWindowDays: 30,
    location,
  });
  await read(
    await f.send(
      "/api/owner",
      { ...settings, event: { ...settings.event, title: "Edited A", durationMinutes: 60 } },
      f.ownerHeaders,
      "PUT"
    )
  );
  assert.deepEqual(await getSettings(f.db, created.id), b);
  const publicB = await read(await f.request(`/api/events/${created.id}`));
  const { location: _location, ...publicEvent } = b.event;
  assert.deepEqual(publicB, {
    id: created.id,
    organizer: { name: "Organizer" },
    event: publicEvent,
    schedule: settings.schedule,
  });
  assert.ok(!JSON.stringify(publicB).includes("Room B"));
  assert.equal((await read(await f.request("/api/public"))).event.title, "Edited A");
  assert.equal(
    await f.db.prepare("SELECT json -> '$.event' AS event FROM organizer_settings").first("event"),
    null
  );
  const before = (await f.db.prepare("SELECT * FROM event_type ORDER BY id").all()).results;
  await read(await f.send(path, { ...details, slug: "intro" }, f.ownerHeaders, "PATCH"), 409);
  assert.deepEqual((await f.db.prepare("SELECT * FROM event_type ORDER BY id").all()).results, before);
  const duplicates = await Promise.all(
    [0, 1].map(() => f.send("/api/owner/events", { ...details, slug: "raced" }, f.ownerHeaders))
  );
  assert.deepEqual(duplicates.map((r) => r.status).sort(), [201, 409]);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM event_type WHERE json_extract(json,'$.slug')='raced'")
      .first("n"),
    1
  );
  for (const target of ["missing", "default/extra", "default%2Fextra", crypto.randomUUID()]) {
    assert.equal((await f.request(`/api/owner/events/${target}`, { headers: f.ownerHeaders })).status, 404);
    assert.equal((await f.request(`/api/events/${target}`)).status, 404);
  }
  for (const query of ["?owner=true", "?id=default&id=default", "?eventId=default"]) {
    assert.equal((await f.request(`${path}${query}`, { headers: f.ownerHeaders })).status, 400);
    assert.equal((await f.request(`/api/events/${created.id}${query}`)).status, 400);
  }
  const frozen = (await f.db.prepare("SELECT * FROM event_type ORDER BY id").all()).results;
  for (const headers of [
    {},
    { Authorization: `Bearer ${"a".repeat(43)}` },
    { Cookie: "flare_session=invalid" },
  ]) {
    for (const target of [
      "/api/owner/events",
      "/api/owner/events/missing?bad=%ZZ",
      `${path}/booking-rules`,
    ]) {
      assert.equal(
        (await f.send(target, { owner: true }, headers, target.endsWith("events") ? "POST" : "PATCH")).status,
        401
      );
      assert.equal((await f.request(target, { headers })).status, 401);
    }
  }
  assert.equal(
    (await f.send(path, {}, { ...f.ownerHeaders, Origin: "https://foreign.test" }, "PATCH")).status,
    403
  );
  assert.equal((await f.send("/api/owner/events", { ...details, owner: true }, f.ownerHeaders)).status, 400);
  await f.db.prepare("UPDATE owner_session SET expires_at=0").run();
  assert.equal((await f.send("/api/owner/events/missing", {}, f.ownerHeaders, "PATCH")).status, 401);
  await f.db.prepare("DELETE FROM owner_session").run();
  assert.equal((await f.send("/api/owner/events", details, f.ownerHeaders)).status, 401);
  assert.deepEqual((await f.db.prepare("SELECT * FROM event_type ORDER BY id").all()).results, frozen);
  assert.equal(f.calendar.writes.length, 0);
});

test("HTTP replay preserves rejection and event identity before parsing current event policy", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const { id } = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  const path = `/api/events/${id}/bookings`;
  const accepted = input(f.now() + 9 * hour);
  await read(await f.send("/api/bookings", accepted), 201);
  const rejectedB = { ...accepted, requestKey: crypto.randomUUID() };
  const rejectedA = { ...accepted, requestKey: crypto.randomUUID() };
  await read(await f.send(path, rejectedB), 409);
  await read(await f.send("/api/bookings", rejectedA), 409);
  const commands = (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results;
  let providerReads = 0;
  let providerWrites = 0;
  const busy = f.calendar.busy.bind(f.calendar);
  const get = f.calendar.get.bind(f.calendar);
  const insert = f.calendar.insert.bind(f.calendar);
  const update = f.calendar.update.bind(f.calendar);
  const remove = f.calendar.delete.bind(f.calendar);
  f.calendar.busy = async (...args) => {
    providerReads++;
    return busy(...args);
  };
  f.calendar.get = async (...args) => {
    providerReads++;
    return get(...args);
  };
  f.calendar.insert = async (...args) => {
    providerWrites++;
    return insert(...args);
  };
  f.calendar.update = async (...args) => {
    providerWrites++;
    return update(...args);
  };
  f.calendar.delete = async (...args) => {
    providerWrites++;
    return remove(...args);
  };
  await f.db.prepare("UPDATE event_type SET json='{}'").run();
  const replayed = await Promise.all(
    [
      { target: path, data: rejectedB },
      { target: path, data: accepted },
      { target: "/api/bookings", data: rejectedA },
      { target: "/api/events/default/bookings", data: rejectedA },
    ].map(async ({ target, data }) => {
      const response = await f.send(target, data);
      return { status: response.status, body: await response.json() };
    })
  );
  assert.deepEqual(replayed, [
    { status: 409, body: { error: "conflict", message: "conflict" } },
    { status: 409, body: { error: "idempotency_mismatch", message: "idempotency_mismatch" } },
    { status: 409, body: { error: "conflict", message: "conflict" } },
    { status: 409, body: { error: "conflict", message: "conflict" } },
  ]);
  assert.deepEqual(
    (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
    commands
  );
  assert.equal(providerReads, 0);
  assert.equal(providerWrites, 0);
  assert.deepEqual(await read(await f.send(path, input(f.now() + 12 * hour)), 400), {
    error: "INVALID_SETTINGS",
  });
  assert.deepEqual(await read(await f.send(path, { ...accepted, owner: true }), 400), {
    error: "invalid_input",
    message: "invalid_input",
  });
  assert.deepEqual(await read(await f.send(`${path}?eventId=default`, accepted), 400), {
    error: "invalid_query",
    message: "invalid_query",
  });
  assert.equal((await f.send(path, accepted, { Origin: "https://foreign.test" })).status, 403);
  assert.equal((await f.send(`/api/events/${crypto.randomUUID()}/bookings`, accepted)).status, 404);
  await f.db.prepare("DELETE FROM event_type WHERE id=?").bind(id).run();
  assert.equal((await f.send(path, rejectedB)).status, 404);
  assert.deepEqual(
    (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
    commands
  );
  assert.equal(providerReads, 0);
  assert.equal(providerWrites, 0);
});

for (const corruption of ["event", "preferences"]) {
  test(`accepted HTTP replay retains historical facts with conservative actions under invalid ${corruption}`, async (t) => {
    const f = await apiFixture();
    t.after(f.close);
    const { id } = await read(
      await f.send("/api/owner/events", { ...details, location: "Historical room 東京" }, f.ownerHeaders),
      201
    );
    const path = `/api/events/${id}/bookings`;
    const service = new BookingService({
      db: f.db,
      calendar: f.calendar,
      secret: f.env.TOKEN_ENCRYPTION_KEY,
      now: f.now,
    });
    const busy = f.calendar.busy.bind(f.calendar);
    const get = f.calendar.get.bind(f.calendar);
    const insert = f.calendar.insert.bind(f.calendar);
    let reads = 0;
    let writes = 0;
    let rejectInsert = false;
    f.calendar.busy = async (...args) => {
      reads++;
      return busy(...args);
    };
    f.calendar.get = async (...args) => {
      reads++;
      return get(...args);
    };
    f.calendar.insert = async (...args) => {
      writes++;
      if (rejectInsert) throw new GoogleCalendarError("retryable", 429, "Not applied");
      return insert(...args);
    };
    const accepted = [];
    for (const [offset, mode] of ["completed", "queued", "sent"].entries()) {
      rejectInsert = mode === "queued";
      if (mode === "sent") f.calendar.cutAfter = "insert";
      const data = input(f.now() + (9 + offset * 3) * hour);
      const booking = await read(await f.send(path, data), mode === "completed" ? 201 : 202);
      assert.equal(Object.hasOwn(booking, "disableCancelling"), false);
      assert.equal(Object.hasOwn(booking, "disableRescheduling"), false);
      accepted.push({ data, booking });
    }
    rejectInsert = false;
    if (corruption === "event")
      await f.db.prepare("UPDATE event_type SET json='{}' WHERE id=?").bind(id).run();
    else await f.db.prepare("UPDATE organizer_settings SET json='broken JSON'").run();
    const before = (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results;
    const beforeReads = reads;
    const beforeWrites = writes;
    const completed = accepted[0];
    assert.ok(completed);
    const completedReplay = await read(await f.send(path, completed.data), 201);
    assert.equal(completedReplay.status, "confirmed");
    assert.equal(completedReplay.manageToken, completed.booking.manageToken);
    for (const { booking } of accepted) {
      const { manageToken, ...facts } = booking;
      const expected = { ...facts, disableCancelling: true, disableRescheduling: true };
      const attendee = await read(
        await f.request(`/api/bookings/${booking.id}`, {
          headers: { Authorization: `Bearer ${manageToken}` },
        })
      );
      const owner = await read(
        await f.request(`/api/owner/bookings/${booking.id}`, { headers: f.ownerHeaders })
      );
      assert.deepEqual(attendee, expected);
      assert.deepEqual(owner, expected);
      assert.deepEqual(
        (await service.ownerList()).find((row) => row.id === booking.id),
        expected
      );
      if (corruption === "event") {
        const home = await read(await f.request("/api/owner", { headers: f.ownerHeaders }));
        assert.deepEqual(
          home.bookings.find((row: { id: string }) => row.id === booking.id),
          expected
        );
      }
    }
    assert.deepEqual(
      (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
      before
    );
    assert.equal(reads, beforeReads);
    assert.equal(writes, beforeWrites);
    for (const { data, booking } of accepted) {
      const replay = await read(await f.send(path, data), 201);
      const { pendingAction: _action, error: _error, ...confirmedFacts } = booking;
      assert.deepEqual(replay, {
        ...confirmedFacts,
        status: "confirmed",
        disableCancelling: true,
        disableRescheduling: true,
        location: "Historical room 東京",
      });
      assert.equal(replay.manageToken, booking.manageToken);
      assert.equal(f.calendar.writes.filter((write) => write.id === booking.id).length, 1);
    }
    const stable = (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results;
    const stableReads = reads;
    const stableWrites = writes;
    for (const { data, booking } of accepted) {
      const replay = await read(await f.send(path, data), 201);
      assert.equal(replay.id, booking.id);
      assert.equal(replay.manageToken, booking.manageToken);
      assert.equal(replay.status, "confirmed");
    }
    const target = accepted[0]?.booking;
    assert.ok(target);
    await read(await f.send(path, input(f.now() + 33 * hour)), 400);
    await read(
      await f.send(
        `/api/owner/bookings/${target.id}`,
        { action: "reschedule", requestKey: crypto.randomUUID(), version: 1, start: f.now() + 40 * hour },
        f.ownerHeaders
      ),
      400
    );
    await read(
      await f.send(
        `/api/owner/bookings/${target.id}`,
        {
          action: "cancel",
          requestKey: crypto.randomUUID(),
          version: 1,
          cancellationReason: "Current settings unavailable",
        },
        f.ownerHeaders
      ),
      400
    );
    assert.equal(
      (
        await f.request(`/api/bookings/${target.id}`, {
          headers: { Authorization: `Bearer ${"A".repeat(43)}` },
        })
      ).status,
      404
    );
    assert.equal((await f.request(`/api/owner/bookings/${target.id}`)).status, 401);
    assert.deepEqual(
      (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
      stable
    );
    assert.equal(reads, stableReads);
    assert.equal(writes, stableWrites);
    for (const command of before) {
      const current = stable.find((row) => row.id === command.id);
      assert.ok(current);
      for (const field of [
        "payload",
        "settings_json",
        "desired_json",
        "token_hash",
        "occupied_start",
        "occupied_end",
        "outcome",
      ])
        assert.equal(current[field], command[field]);
    }
  });
}

test("historical private views tolerate missing policy rows but propagate broken booking facts and D1 failures", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const { id } = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  const data = input(f.now() + 9 * hour);
  const booking = await read(await f.send(`/api/events/${id}/bookings`, data), 201);
  const auth = { Authorization: `Bearer ${booking.manageToken}` };
  const service = new BookingService({
    db: f.db,
    calendar: f.calendar,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: f.now,
  });
  const event = await f.db.prepare("SELECT * FROM event_type WHERE id=?").bind(id).first();
  const preferences = await f.db.prepare("SELECT * FROM organizer_settings").first();
  assert.ok(event && preferences);
  const { manageToken: _token, ...facts } = booking;
  const expected = { ...facts, disableCancelling: true, disableRescheduling: true };
  await f.db
    .prepare(`UPDATE event_type SET json=json_set(json,'$.durationMinutes',0,
    '$.disableCancelling',json('false'),'$.disableRescheduling',json('false')) WHERE id=?`)
    .bind(id)
    .run();
  assert.deepEqual(await read(await f.request(`/api/bookings/${booking.id}`, { headers: auth })), expected);
  assert.deepEqual(
    (await service.ownerList()).find((row) => row.id === booking.id),
    expected
  );
  await f.db.prepare("DELETE FROM event_type WHERE id=?").bind(id).run();
  assert.deepEqual(await read(await f.request(`/api/bookings/${booking.id}`, { headers: auth })), expected);
  assert.deepEqual(
    await read(await f.request(`/api/owner/bookings/${booking.id}`, { headers: f.ownerHeaders })),
    expected
  );
  assert.deepEqual(
    (await service.ownerList()).find((row) => row.id === booking.id),
    expected
  );
  assert.equal((await f.send(`/api/events/${id}/bookings`, data)).status, 404);
  await f.db
    .prepare("INSERT INTO event_type(id,json,version) VALUES (?,?,?)")
    .bind(event.id, event.json, event.version)
    .run();
  await f.db.prepare("DELETE FROM organizer_settings").run();
  assert.deepEqual(await read(await f.request(`/api/bookings/${booking.id}`, { headers: auth })), expected);
  assert.deepEqual(
    (await service.ownerList()).find((row) => row.id === booking.id),
    expected
  );
  await f.db
    .prepare("INSERT INTO organizer_settings VALUES (?,?,?)")
    .bind(preferences.id, preferences.json, preferences.version)
    .run();
  const stored = await f.db
    .prepare("SELECT confirmed_json FROM booking WHERE id=?")
    .bind(booking.id)
    .first<string>("confirmed_json");
  await f.db.prepare("UPDATE booking SET confirmed_json='{' WHERE id=?").bind(booking.id).run();
  assert.equal((await f.request(`/api/bookings/${booking.id}`, { headers: auth })).status, 503);
  await f.db.prepare("UPDATE booking SET confirmed_json=? WHERE id=?").bind(stored, booking.id).run();
  assert.deepEqual(await read(await f.request(`/api/bookings/${booking.id}`, { headers: auth })), facts);
  const commands = (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results;
  await f.db.prepare("DROP TABLE event_type").run();
  assert.equal((await f.request(`/api/bookings/${booking.id}`, { headers: auth })).status, 503);
  await assert.rejects(service.ownerList(), /no such table/);
  assert.deepEqual(
    (await f.db.prepare("SELECT * FROM booking_command ORDER BY rowid").all()).results,
    commands
  );
  assert.equal(f.calendar.writes.length, 1);
});

test("event admission fences only selected definitions and shared preferences with exact raw bytes", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const { id } = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  const service = new BookingService({
    db: f.db,
    calendar: f.calendar,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: f.now,
  });
  const initial = await getSettings(f.db, id);
  await saveBookingRules(f.db, rules, id);
  const originalBusy = f.calendar.busy.bind(f.calendar);
  let serial = 0;
  for (const location of ["Room\ud800tail", "Room\udffftail", "Room\u0000tail", '東京 😀 "literal"\nroom']) {
    await saveEventDetails(f.db, { ...details, location }, id);
    for (const bookingWindowDays of [1, undefined, null, 365]) {
      await saveBookingRules(
        f.db,
        { ...rules, ...(bookingWindowDays === undefined ? {} : { bookingWindowDays }) },
        id
      );
      const current = await getSettings(f.db, id);
      const { event, ...preferences } = current;
      assert.equal(
        await f.db.prepare("SELECT json FROM event_type WHERE id=?").bind(id).first("json"),
        JSON.stringify(event)
      );
      assert.equal(
        await f.db.prepare("SELECT json FROM organizer_settings").first("json"),
        JSON.stringify(preferences)
      );
      const created = await service.create(input(f.now() + ++serial * hour), id);
      assert.equal(created.status, "confirmed");
      assert.equal(created.location, location);
    }
  }
  for (const edit of ["A", "B", "shared"] as const) {
    f.calendar.busy = async (...args) => {
      f.calendar.busy = originalBusy;
      if (edit === "shared")
        await f.db
          .prepare("UPDATE organizer_settings SET json=json_set(json,'$.conflictCalendarIds',json('[]'))")
          .run();
      else
        await saveEventDetails(
          f.db,
          { ...details, slug: edit === "A" ? "intro" : details.slug, title: `Changed ${edit}` },
          edit === "A" ? "default" : id
        );
      return originalBusy(...args);
    };
    const data = input(f.now() + ++serial * hour);
    if (edit === "A") assert.equal((await service.create(data, id)).status, "confirmed");
    else {
      await assert.rejects(service.create(data, id), /settings_changed/);
      const before = (
        await f.db.prepare("SELECT * FROM booking_command WHERE request_key=?").bind(data.requestKey).all()
      ).results;
      await assert.rejects(service.create(data, id), /settings_changed/);
      assert.deepEqual(
        (await f.db.prepare("SELECT * FROM booking_command WHERE request_key=?").bind(data.requestKey).all())
          .results,
        before
      );
    }
  }
  for (const corruption of ["raw", "missing-preferences"] as const) {
    const preferences = await f.db.prepare("SELECT json FROM organizer_settings").first<string>("json");
    const event = await f.db.prepare("SELECT json FROM event_type WHERE id=?").bind(id).first<string>("json");
    f.calendar.busy = async (...args) => {
      f.calendar.busy = originalBusy;
      if (corruption === "raw")
        await f.db.prepare("UPDATE event_type SET json='{ '||substr(json,2) WHERE id=?").bind(id).run();
      else await f.db.prepare("DELETE FROM organizer_settings").run();
      return originalBusy(...args);
    };
    const data = input(f.now() + ++serial * hour);
    await assert.rejects(service.create(data, id), /settings_changed/);
    assert.equal(
      await f.db
        .prepare("SELECT outcome FROM booking_command WHERE request_key=?")
        .bind(data.requestKey)
        .first("outcome"),
      "settings_changed"
    );
    if (corruption === "raw")
      await f.db.prepare("UPDATE event_type SET json=? WHERE id=?").bind(event, id).run();
    else await f.db.prepare("INSERT INTO organizer_settings VALUES ('owner',?,1)").bind(preferences).run();
  }
  assert.equal(initial.event.noticeMinutes, 120);
});

test("event buffers, old and candidate move holds remain global with an explicit empty conflict selection", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const { id } = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  await saveBookingRules(f.db, { ...rules, beforeMinutes: 10, afterMinutes: 10 }, id);
  await saveSettings(f.db, { ...settings, conflictCalendarIds: [] });
  const service = new BookingService({
    db: f.db,
    calendar: f.calendar,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: f.now,
  });
  const b = await service.create(input(f.now() + 9 * hour), id);
  assert.ok(b.manageToken);
  await assert.rejects(service.create(input(f.now() + 8 * hour + hour / 2)), /conflict/);
  assert.equal((await service.create(input(b.end + 10 * 60_000))).status, "confirmed");
  const update = f.calendar.update.bind(f.calendar);
  f.calendar.update = async () => {
    throw new GoogleCalendarError("retryable", 429, "Not applied");
  };
  const move = {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: 1,
    start: f.now() + 14 * hour,
  };
  assert.equal((await service.change(b.id, b.manageToken, move)).status, "attention");
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM booking_reservation WHERE booking_id=?")
      .bind(b.id)
      .first("n"),
    2
  );
  for (const start of [b.start, move.start]) await assert.rejects(service.create(input(start)), /conflict/);
  assert.equal((await service.create(input(f.now() + 11 * hour))).status, "confirmed");
  f.calendar.update = update;
  assert.equal((await service.retry(b.id, b.manageToken)).status, "confirmed");
  assert.equal((await service.create(input(b.start))).status, "confirmed");
  const cancelled = await service.change(b.id, b.manageToken, {
    action: "cancel",
    requestKey: crypto.randomUUID(),
    version: 2,
  });
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await service.create(input(move.start))).status, "confirmed");
  const same = input(f.now() + 18 * hour);
  const pair = await Promise.all([service.create(same, id), service.create(same, id)]);
  assert.equal(pair[0].id, pair[1].id);
  assert.equal(pair[0].manageToken, pair[1].manageToken);
  assert.equal(
    await f.db
      .prepare("SELECT count(*) AS n FROM booking_command WHERE request_key=?")
      .bind(same.requestKey)
      .first("n"),
    1
  );
  assert.equal(f.calendar.writes.filter((write) => write.id === pair[0].id).length, 1);
});

test("cross-event occupancy, replay identity and private moves retain historical event context", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const { id } = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  await saveBookingRules(f.db, rules, id);
  await read(
    await f.send("/api/owner/conflict-calendars", { conflictCalendarIds: [] }, f.ownerHeaders, "PATCH")
  );
  const service = new BookingService({
    db: f.db,
    calendar: f.calendar,
    settings,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: f.now,
  });
  const data = input(f.now() + 9 * hour);
  const created = await service.create(data, id);
  assert.ok(created.manageToken);
  assert.equal(created.end - created.start, 45 * 60_000);
  const command = await f.db
    .prepare("SELECT * FROM booking_command WHERE request_key=?")
    .bind(data.requestKey)
    .first();
  const writes = f.calendar.writes.length;
  await assert.rejects(service.create(data), /idempotency_mismatch/);
  assert.equal(f.calendar.writes.length, writes);
  assert.deepEqual(
    await f.db.prepare("SELECT * FROM booking_command WHERE request_key=?").bind(data.requestKey).first(),
    command
  );
  const races = await Promise.allSettled([
    service.create(input(f.now() + 11 * hour)),
    service.create(input(f.now() + 11 * hour), id),
  ]);
  assert.equal(races.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(races.filter((r) => r.status === "rejected" && /conflict/.test(String(r.reason))).length, 1);
  await assert.rejects(service.create(input(created.end - 5 * 60_000)), /conflict/);
  assert.equal((await service.create(input(created.end))).status, "confirmed");
  await saveEventDetails(
    f.db,
    { ...details, slug: "new-b", title: "Future B", durationMinutes: 90, location: "Future room" },
    id
  );
  await saveSettings(f.db, {
    ...settings,
    conflictCalendarIds: [],
    event: { ...settings.event, disableCancelling: true, disableRescheduling: true },
  });
  const auth = { Authorization: `Bearer ${created.manageToken}` };
  const query = new URLSearchParams({
    from: new Date(f.now() + 15 * hour).toISOString(),
    to: new Date(f.now() + 16 * hour).toISOString(),
    timeZone: "UTC",
  });
  const available = await read(
    await f.request(`/api/slots?bookingId=${created.id}&${query}`, { headers: auth })
  );
  assert.equal(available.slots[0].end - available.slots[0].start, 45 * 60_000);
  const before = await f.db
    .prepare("SELECT initial_json FROM booking WHERE id=?")
    .bind(created.id)
    .first("initial_json");
  const moved = await read(
    await f.send(
      `/api/bookings/${created.id}`,
      { action: "reschedule", requestKey: crypto.randomUUID(), version: 1, start: f.now() + 15 * hour },
      auth
    )
  );
  assert.equal(moved.title, "Second event");
  assert.equal(moved.end - moved.start, 45 * 60_000);
  assert.equal(moved.location, undefined);
  assert.equal(
    await f.db.prepare("SELECT initial_json FROM booking WHERE id=?").bind(created.id).first("initial_json"),
    before
  );
  assert.equal(f.calendar.events.get(created.id)?.summary, "Second event");
  assert.match(f.calendar.events.get(created.id)?.description ?? "", /Historical notes/);
  const owner = await read(await f.request("/api/owner", { headers: f.ownerHeaders }));
  const historical = owner.bookings.find((b: { id: string }) => b.id === created.id);
  assert.equal(historical.title, "Second event");
  assert.equal(historical.disableCancelling, false);
  assert.equal(historical.disableRescheduling, false);
  const wrong = { Authorization: `Bearer ${"A".repeat(43)}` };
  assert.equal((await f.request(`/api/bookings/${created.id}`, { headers: wrong })).status, 404);
  assert.equal(
    (await f.request(`/api/slots?bookingId=${created.id}&${query}`, { headers: wrong })).status,
    404
  );
  await saveBookingRules(f.db, { ...rules, disableRescheduling: true }, id);
  const rejected = await f.send(
    `/api/bookings/${created.id}`,
    { action: "reschedule", requestKey: crypto.randomUUID(), version: 2, start: f.now() + 17 * hour },
    auth
  );
  assert.equal(rejected.status, 409);
  assert.equal((await rejected.json()).error, "invalid_slot");
  const cancelled = await read(
    await f.send(
      `/api/bookings/${created.id}`,
      { action: "cancel", requestKey: crypto.randomUUID(), version: 2 },
      auth
    )
  );
  assert.equal(cancelled.status, "cancelled");
  assert.equal((await service.create(input(f.now() + 15 * hour), id)).status, "confirmed");
  await assert.rejects(
    f.db.prepare("UPDATE booking SET event_id='default' WHERE id=?").bind(created.id).run(),
    /immutable_event/
  );
  await assert.rejects(
    f.db
      .prepare("UPDATE booking_command SET event_id='default' WHERE request_key=?")
      .bind(data.requestKey)
      .run(),
    /idempotency_mismatch/
  );
});

test("event queued and lost-ack recovery uses frozen settings despite later global and event edits", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const { id } = await read(
    await f.send("/api/owner/events", { ...details, location: "Frozen room" }, f.ownerHeaders),
    201
  );
  await saveBookingRules(f.db, rules, id);
  const service = new BookingService({
    db: f.db,
    calendar: f.calendar,
    secret: f.env.TOKEN_ENCRYPTION_KEY,
    now: f.now,
  });
  const insert = f.calendar.insert.bind(f.calendar);
  for (const mode of ["queued", "sent"] as const) {
    await saveBookingRules(f.db, rules, id);
    await saveSettings(f.db, settings);
    if (mode === "queued")
      f.calendar.insert = async () => {
        throw new GoogleCalendarError("retryable", 429, "Not applied");
      };
    else f.calendar.cutAfter = "insert";
    const data = input(f.now() + (mode === "queued" ? 9 : 12) * hour);
    const pending = await service.create(data, id);
    assert.equal(pending.status, "attention");
    const frozen = await f.db
      .prepare("SELECT settings_json,desired_json,execution FROM booking_command WHERE request_key=?")
      .bind(data.requestKey)
      .first();
    assert.equal(frozen?.execution, mode);
    f.calendar.insert = insert;
    await saveBookingRules(f.db, { ...rules, noticeMinutes: 43200, bookingWindowDays: 1 }, id);
    await saveSettings(f.db, {
      ...settings,
      schedule: { ...settings.schedule, rules: [] },
      conflictCalendarIds: [],
    });
    await f.db
      .prepare("UPDATE booking_command SET due=0,lease_until=0 WHERE request_key=?")
      .bind(data.requestKey)
      .run();
    await service.recover();
    assert.ok(pending.manageToken);
    const confirmed = await service.view(pending.id, pending.manageToken);
    assert.equal(confirmed.status, "confirmed");
    assert.equal(confirmed.location, "Frozen room");
    assert.equal(f.calendar.writes.filter((w) => w.id === pending.id).length, 1);
    const current = await f.db
      .prepare("SELECT settings_json,desired_json,execution FROM booking_command WHERE request_key=?")
      .bind(data.requestKey)
      .first();
    assert.deepEqual(current, { ...frozen, execution: "done" });
  }
  assert.deepEqual(parseSettings(await getSettings(f.db)).schedule.rules, []);
});
