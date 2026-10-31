import assert from "node:assert/strict";
import { test } from "node:test";
import { defaultSettings } from "../src/domain/settings.ts";
import { getOwnerBookings, getOwnerEventData, getOwnerSchedules } from "../src/server/app.ts";
import { BookingService } from "../src/server/bookings.ts";
import { GoogleCalendarError } from "../src/server/google.ts";
import { getSettings } from "../src/server/settings.ts";
import { apiFixture, hour, settings } from "./fixtures/api.ts";

async function read(response: Response, status = 200) {
  assert.equal(response.status, status, await response.clone().text());
  assert.equal(response.headers.get("Cache-Control"), "no-store");
  return response.json();
}
const input = (start: number) => ({
  requestKey: crypto.randomUUID(),
  start,
  name: "Guest",
  email: "guest@example.test",
  timeZone: "UTC",
});
const details = { slug: "second", title: "Second", description: "", durationMinutes: 30 };
const service = (f: Awaited<ReturnType<typeof apiFixture>>) =>
  new BookingService({ db: f.db, calendar: f.calendar, secret: f.env.TOKEN_ENCRYPTION_KEY, now: f.now });

test("schedule manager SSR authenticates before strict selection and survives removal of every event", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const page = (query: string, authenticated = true) =>
    getOwnerSchedules(
      new Request(`${f.env.PUBLIC_ORIGIN}/owner/schedules${query}`, {
        headers: authenticated ? f.ownerHeaders : {},
      }),
      { env: f.env }
    );
  const initial = await page("");
  assert.equal(initial?.selectedId, "legacy");
  for (const query of [
    "?scheduleId=invalid",
    `?scheduleId=${crypto.randomUUID()}`,
    "?scheduleId=legacy&scheduleId=legacy",
    "?eventId=default",
    "?scheduleId=",
  ]) {
    assert.equal(await page(query, false), null);
    await assert.rejects(page(query));
  }
  const created = await read(
    await f.send("/api/owner/schedules", { name: "Private name 東京" }, f.ownerHeaders),
    201
  );
  await read(
    await f.send("/api/owner/events/default/schedule", { scheduleId: created.id }, f.ownerHeaders, "PATCH")
  );
  const eventPage = await getOwnerEventData(new Request(f.env.PUBLIC_ORIGIN, { headers: f.ownerHeaders }), {
    env: f.env,
    calendar: f.calendar,
    now: f.now,
  });
  assert.equal(eventPage?.eventScheduleId, created.id);
  assert.equal(eventPage?.scheduleId, created.id);
  const wire = await read(await f.request("/api/owner/events/default", { headers: f.ownerHeaders }));
  assert.deepEqual(Object.keys(wire).sort(), ["event", "id", "lifecycle"]);
  assert.equal((await page(`?scheduleId=${created.id}`))?.selectedId, created.id);
  await f.db.prepare("UPDATE event_type SET lifecycle='removed'").run();
  assert.equal((await page(""))?.selectedId, "legacy");
  await f.db.prepare("UPDATE availability_schedule SET json='{}' WHERE id='legacy'").run();
  await assert.rejects(page(""));
  await f.db
    .prepare("UPDATE availability_schedule SET json=?,name=' padded ' WHERE id='legacy'")
    .bind(JSON.stringify(settings.schedule))
    .run();
  await assert.rejects(page(""));
  await f.db.prepare("UPDATE availability_schedule SET name='Working hours' WHERE id='legacy'").run();
  await f.db.prepare("DELETE FROM organizer_settings").run();
  await assert.rejects(page(""), /temporarily_unavailable/);
  assert.equal(await page("?scheduleId=invalid", false), null);
});

test("schedule mutations authorize the owner before checking Origin or reading input", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const capture = () =>
    Promise.all(
      ["availability_schedule", "organizer_settings", "event_type", "booking_command"].map((table) =>
        f.db
          .prepare(`SELECT * FROM ${table} ORDER BY rowid`)
          .all()
          .then((result) => result.results)
      )
    );
  const before = await capture();
  const mutations = [
    { path: "/api/owner/schedules", method: "POST" },
    { path: "/api/owner/schedules/legacy", method: "PATCH" },
    { path: "/api/owner/schedules/legacy", method: "DELETE" },
    { path: "/api/owner/schedules/legacy/weekly", method: "PATCH" },
    { path: "/api/owner/schedules/legacy/overrides", method: "PATCH" },
    { path: "/api/owner/schedules/legacy/duplicate", method: "POST" },
    { path: "/api/owner/schedules/legacy/default", method: "PATCH" },
    { path: "/api/owner/events/default/schedule", method: "PATCH" },
  ];
  for (const { path, method } of mutations) {
    for (const origin of [undefined, "https://foreign.example.test"]) {
      const headers = origin ? { Origin: origin } : {};
      assert.deepEqual(await read(await f.request(path, { method, headers, body: "malformed JSON" }), 401), {
        error: "unauthorized",
        message: "unauthorized",
      });
      assert.deepEqual(
        await read(
          await f.request(path, {
            method,
            headers: { ...headers, ...f.ownerHeaders },
            body: "malformed JSON",
          }),
          403
        ),
        { error: "invalid_origin", message: "invalid_origin" }
      );
    }
  }
  assert.deepEqual(await capture(), before);
  assert.equal(f.calendar.writes.length, 0);
});

test("owner schedule catalog has one migrated default and creates independent named schedules", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const initial = await f.request("/api/owner/schedules", { headers: f.ownerHeaders });
  assert.equal(initial.status, 200);
  const catalog = await initial.json();
  assert.equal(catalog.schedules.length, 1);
  assert.equal(catalog.defaultScheduleId, catalog.schedules[0].id);
  const created = await f.send("/api/owner/schedules", { name: "Other hours" }, f.ownerHeaders);
  assert.equal(created.status, 201);
  const schedule = await created.json();
  assert.equal(schedule.name, "Other hours");
  assert.notEqual(schedule.id, catalog.defaultScheduleId);
  assert.equal(Object.hasOwn(schedule.schedule, "overrides"), false);
  const after = await (await f.request("/api/owner/schedules", { headers: f.ownerHeaders })).json();
  assert.equal(after.defaultScheduleId, catalog.defaultScheduleId);
  assert.equal(after.schedules.length, 2);
  assert.equal(f.calendar.writes.length, 0);
});

test("0006 upgrade preserves historical bytes and exact SQL schedule projection, rejecting missing or corrupt schedules", async (t) => {
  const f = await apiFixture({ legacySchedules: true });
  t.after(f.close);
  const raw = '{ "schedule" : { "overrides":[], "rules":[], "timeZone":"UTC" }, "conflictCalendarIds":[] }';
  for (const [index, mode] of ["completed", "queued", "sent", "rejected"].entries()) {
    const start = mode === "rejected" ? 0 : index * 2 * hour;
    await f.db
      .prepare(`INSERT INTO booking_command(id,request_key,booking_id,action,payload,expected_version,
      desired_json,settings_json,token_hash,occupied_start,occupied_end,precondition,due)
      SELECT ?,?,?,'create',' {"historical":"payload"} ',0,' {"historical":"desired"} ',
      '{"event":'||e.json||','||substr(o.json,2),'frozen-token-hash',?,?,'accepted',0
      FROM event_type e JOIN organizer_settings o ON o.id='owner' WHERE e.id='default'`)
      .bind(mode, mode, mode, start, start + hour)
      .run();
    if (mode === "completed")
      await f.db
        .prepare("UPDATE booking_command SET execution='done',result_etag='old-etag',terminal=1 WHERE id=?")
        .bind(mode)
        .run();
    if (mode === "sent")
      await f.db
        .prepare("UPDATE booking_command SET execution='sent',dispatch_nonce='old-dispatch' WHERE id=?")
        .bind(mode)
        .run();
  }
  await f.db.prepare("UPDATE organizer_settings SET json=?,version=17").bind(raw).run();
  const projection = await f.db
    .prepare("SELECT json -> '$.schedule' AS json FROM organizer_settings")
    .first("json");
  const capture = () =>
    Promise.all(
      ["booking", "booking_command", "booking_reservation", "event_type"].map((table) =>
        f.db.prepare(`SELECT rowid AS cursor,* FROM ${table} ORDER BY rowid`).all()
      )
    ).then((rows) => rows.map((r) => r.results));
  const before = await capture();
  assert.deepEqual(
    before[1].map((r) => r.outcome),
    ["accepted", "accepted", "accepted", "conflict"]
  );
  await f.migrateSchedules();
  const after = await capture();
  assert.deepEqual(after[0], before[0]);
  assert.deepEqual(after[2], before[2]);
  assert.deepEqual(
    after[1].map(({ event_schedule_id, resolved_schedule_id, ...row }) => {
      assert.equal(event_schedule_id, null);
      assert.equal(resolved_schedule_id, null);
      return row;
    }),
    before[1]
  );
  assert.deepEqual(
    after[3].map(({ schedule_id, ...row }) => {
      assert.equal(schedule_id, null);
      return row;
    }),
    before[3]
  );
  assert.equal(await f.db.prepare("SELECT json FROM availability_schedule").first("json"), projection);
  assert.equal(await f.db.prepare("SELECT version FROM availability_schedule").first("version"), 17);
  assert.equal(
    await f.db.prepare("SELECT json FROM organizer_settings").first("json"),
    '{"conflictCalendarIds":[]}'
  );
  assert.deepEqual((await getSettings(f.db)).schedule, { timeZone: "UTC", rules: [], overrides: [] });
  await assert.rejects(service(f).create(input(f.now() + 9 * hour)), /invalid_slot/);
});

test("0007 migration rolls back invalid structural input and leaves semantic validation to existing parsers", async (t) => {
  const f = await apiFixture({ legacySchedules: true });
  t.after(f.close);
  for (const json of ["broken JSON", "{}", '{"schedule":null}', '{"schedule":[]}', '{"schedule":4}']) {
    await f.db.prepare("UPDATE organizer_settings SET json=?").bind(json).run();
    const before = await f.db.prepare("SELECT rowid AS cursor,* FROM organizer_settings").all();
    await assert.rejects(f.migrateSchedules(), /malformed JSON|NOT NULL|CHECK constraint/);
    assert.deepEqual(
      await f.db
        .prepare("SELECT rowid AS cursor,* FROM organizer_settings")
        .all()
        .then((r) => r.results),
      before.results
    );
    assert.equal(
      await f.db
        .prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='availability_schedule'")
        .first("n"),
      0
    );
    assert.equal(
      await f.db.prepare("SELECT count(*) AS n FROM sqlite_schema WHERE name='booking_admit'").first("n"),
      1
    );
  }
  await f.db.prepare("DELETE FROM organizer_settings").run();
  await assert.rejects(f.migrateSchedules(), /NOT NULL/);
  await f.db
    .prepare("INSERT INTO organizer_settings VALUES ('owner',?,1)")
    .bind(JSON.stringify({ schedule: { timeZone: "Invalid/Zone", rules: [] } }))
    .run();
  await f.migrateSchedules();
  await assert.rejects(getSettings(f.db), /timeZone/);
});

test("accepted create move and cancel recover from queued and sent states after schedule deletion with no duplicate provider applies", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const s = service(f);
  let index = 0;
  for (const action of ["create", "reschedule", "cancel"] as const)
    for (const execution of ["queued", "sent"] as const) {
      const catalog = await read(await f.request("/api/owner/schedules", { headers: f.ownerHeaders }));
      const selected = await read(
        await f.send(
          `/api/owner/schedules/${catalog.defaultScheduleId}/duplicate`,
          { name: "Frozen source" },
          f.ownerHeaders
        ),
        201
      );
      await read(
        await f.send(
          "/api/owner/events/default/schedule",
          { scheduleId: selected.id },
          f.ownerHeaders,
          "PATCH"
        )
      );
      const data = input(f.now() + (9 + index++ * 4) * hour);
      const booked = action === "create" ? null : await s.create(data);
      const change =
        action === "reschedule"
          ? { action, requestKey: crypto.randomUUID(), version: 1, start: data.start + 2 * hour }
          : {
              action: "cancel",
              requestKey: crypto.randomUUID(),
              version: 1,
              cancellationReason: "Frozen reason",
            };
      const apply = () => (action === "create" ? s.create(data) : s.ownerChange(booked?.id ?? "", change));
      const op = action === "create" ? "insert" : action === "reschedule" ? "update" : "delete";
      const originalInsert = f.calendar.insert.bind(f.calendar);
      const originalGet = f.calendar.get.bind(f.calendar);
      if (execution === "sent") f.calendar.cutAfter = op;
      else if (op === "insert")
        f.calendar.insert = async () => {
          throw new GoogleCalendarError("definite", 403, "Fixture refusal");
        };
      else
        f.calendar.get = async () => {
          throw new GoogleCalendarError("definite", 503, "Fixture offline");
        };
      const pending = await apply();
      const command = await f.db
        .prepare("SELECT * FROM booking_command WHERE request_key=?")
        .bind(action === "create" ? data.requestKey : change.requestKey)
        .first();
      assert.equal(command?.outcome, "accepted");
      assert.equal(command?.execution, execution);
      f.calendar.insert = originalInsert;
      f.calendar.get = originalGet;
      await read(await f.send(`/api/owner/schedules/${selected.id}`, undefined, f.ownerHeaders, "DELETE"));
      const writes = f.calendar.writes.length;
      const result = await apply();
      assert.equal(result.id, pending.id);
      assert.equal(result.status, action === "cancel" ? "cancelled" : "confirmed");
      assert.equal(f.calendar.writes.length, writes + (execution === "queued" ? 1 : 0));
      assert.equal((await apply()).id, result.id);
      assert.equal(f.calendar.writes.length, writes + (execution === "queued" ? 1 : 0));
      assert.equal(command?.resolved_schedule_id, selected.id);
      assert.equal(
        await f.db.prepare("SELECT schedule_id FROM event_type WHERE id='default'").first("schedule_id"),
        null
      );
    }
});

test("named schedules resolve explicit and fallback events, duplicate independently and target existing editors", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const patch = (path: string, value: unknown) =>
    f.send(path, value, f.ownerHeaders, "PATCH").then((r) => read(r));
  const record = (id: string) =>
    f.request(`/api/owner/schedules/${id}`, { headers: f.ownerHeaders }).then((r) => read(r));
  const a = (await read(await f.request("/api/owner/schedules", { headers: f.ownerHeaders })))
    .defaultScheduleId;
  const b = await read(await f.send("/api/owner/schedules", { name: "Tokyo" }, f.ownerHeaders), 201);
  const bp = `/api/owner/schedules/${b.id}`;
  const tokyo = { timeZone: "Asia/Tokyo", rules: [{ weekday: 2, startMinute: 540, endMinute: 720 }] };
  const overrides = [
    { date: "2030-01-02", ranges: [] },
    { date: "2030-01-03", ranges: [{ startMinute: 600, endMinute: 660 }] },
  ];
  await patch(`${bp}/weekly`, tokyo);
  await patch(`${bp}/overrides`, { overrides });
  const event = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  await patch(`/api/owner/events/${event.id}/schedule`, { scheduleId: b.id });
  assert.deepEqual((await getSettings(f.db, event.id)).schedule, { ...tokyo, overrides });
  assert.deepEqual((await getSettings(f.db)).schedule, settings.schedule);
  const fallback = await read(
    await f.send("/api/owner/events", { ...details, slug: "fallback" }, f.ownerHeaders),
    201
  );
  const copy = await read(
    await f.send(`/api/owner/events/${event.id}/duplicate`, { ...details, slug: "copied" }, f.ownerHeaders),
    201
  );
  const fallbackCopy = await read(
    await f.send(
      `/api/owner/events/${fallback.id}/duplicate`,
      { ...details, slug: "copied-fallback" },
      f.ownerHeaders
    ),
    201
  );
  assert.equal(
    await f.db.prepare("SELECT schedule_id FROM event_type WHERE id=?").bind(copy.id).first("schedule_id"),
    b.id
  );
  assert.equal(
    await f.db
      .prepare("SELECT schedule_id FROM event_type WHERE id=?")
      .bind(fallbackCopy.id)
      .first("schedule_id"),
    null
  );
  const raw = await f.db
    .prepare("SELECT json FROM availability_schedule WHERE id=?")
    .bind(b.id)
    .first("json");
  const duplicate = await read(await f.send(`${bp}/duplicate`, { name: "Tokyo" }, f.ownerHeaders), 201);
  assert.equal(
    await f.db.prepare("SELECT json FROM availability_schedule WHERE id=?").bind(duplicate.id).first("json"),
    raw
  );
  await patch(bp, { name: "Renamed" });
  await patch(`${bp}/default`, {});
  assert.equal(
    await f.db.prepare("SELECT json FROM availability_schedule WHERE id=?").bind(b.id).first("json"),
    raw
  );
  assert.deepEqual((await getSettings(f.db)).schedule, { ...tokyo, overrides });
  const london = { timeZone: "Europe/London", rules: [{ weekday: 3, startMinute: 600, endMinute: 900 }] };
  await patch(`${bp}/weekly`, london);
  for (const id of ["default", event.id, copy.id, fallback.id, fallbackCopy.id])
    assert.deepEqual((await getSettings(f.db, id)).schedule, { ...london, overrides });
  assert.deepEqual((await record(duplicate.id)).schedule, { ...tokyo, overrides });
  await patch(`/api/owner/schedules/${a}/default`, {});
  const dependencies = { env: f.env, calendar: f.calendar, now: f.now };
  for (const query of [`?eventId=${event.id}`, `?duplicate=${event.id}`]) {
    const page = await getOwnerEventData(
      new Request(`${f.env.PUBLIC_ORIGIN}/${query}`, { headers: f.ownerHeaders }),
      dependencies
    );
    assert.equal(page?.scheduleId, b.id);
    assert.deepEqual(page?.settings.schedule, { ...london, overrides });
    assert.equal(page?.bookingsTimeZone, "UTC");
  }
  const createPage = await getOwnerEventData(
    new Request(`${f.env.PUBLIC_ORIGIN}/?create=1`, { headers: f.ownerHeaders }),
    dependencies
  );
  assert.equal(createPage?.scheduleId, a);
  await patch("/api/owner/schedule", { timeZone: "America/New_York", rules: [] });
  assert.equal((await record(a)).schedule.timeZone, "America/New_York");
  assert.equal((await record(b.id)).schedule.timeZone, "Europe/London");
  await patch("/api/owner/overrides", { overrides: [] });
  assert.deepEqual((await record(a)).schedule.overrides, []);
  await patch("/api/owner/events/default/schedule", { scheduleId: b.id });
  await read(
    await f.send(
      "/api/owner",
      { ...settings, schedule: { timeZone: "UTC", rules: [] } },
      f.ownerHeaders,
      "PUT"
    )
  );
  assert.deepEqual((await record(b.id)).schedule, { timeZone: "UTC", rules: [] });
  assert.equal(
    await f.db.prepare("SELECT schedule_id FROM event_type WHERE id='default'").first("schedule_id"),
    b.id
  );
  const fresh = await read(
    await f.send("/api/owner/schedules", { name: "New York defaults" }, f.ownerHeaders),
    201
  );
  assert.deepEqual(fresh.schedule, { ...defaultSettings.schedule, timeZone: "America/New_York" });
  assert.equal(
    (
      await getOwnerBookings(
        new Request(`${f.env.PUBLIC_ORIGIN}/owner/bookings`, { headers: f.ownerHeaders }),
        dependencies
      )
    )?.timeZone,
    "America/New_York"
  );
});

test("schedule identity and settings are captured together before busy checks while replay keeps first intent", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const s = service(f);
  const patch = (path: string, value: unknown) =>
    f.send(path, value, f.ownerHeaders, "PATCH").then((r) => read(r));
  const a = (await read(await f.request("/api/owner/schedules", { headers: f.ownerHeaders })))
    .defaultScheduleId;
  const b = await read(
    await f.send(`/api/owner/schedules/${a}/duplicate`, { name: "Identical" }, f.ownerHeaders),
    201
  );
  const busy = f.calendar.busy.bind(f.calendar);
  const race = (mutate: () => Promise<unknown>) => {
    f.calendar.busy = async (...args) => {
      f.calendar.busy = busy;
      await mutate();
      return busy(...args);
    };
  };
  let count = 0;
  for (const kind of ["hours", "assignment", "default", "conflicts", "deletion"]) {
    await patch("/api/owner/events/default/schedule", { scheduleId: null });
    await patch(`/api/owner/schedules/${a}/default`, {});
    const replacement =
      kind === "deletion"
        ? await read(
            await f.send(`/api/owner/schedules/${a}/duplicate`, { name: "Delete me" }, f.ownerHeaders),
            201
          )
        : b;
    if (kind === "deletion")
      await patch("/api/owner/events/default/schedule", { scheduleId: replacement.id });
    const data = input(f.now() + (9 + count++ * 2) * hour);
    race(async () => {
      if (kind === "hours")
        return patch(`/api/owner/schedules/${a}/weekly`, { ...settings.schedule, rules: [] });
      if (kind === "assignment") return patch("/api/owner/events/default/schedule", { scheduleId: b.id });
      if (kind === "default") return patch(`/api/owner/schedules/${b.id}/default`, {});
      if (kind === "conflicts") return patch("/api/owner/conflict-calendars", { conflictCalendarIds: [] });
      return read(
        await f.send(`/api/owner/schedules/${replacement.id}`, undefined, f.ownerHeaders, "DELETE")
      );
    });
    await assert.rejects(s.create(data), /settings_changed/);
    const row = await f.db
      .prepare("SELECT * FROM booking_command WHERE request_key=?")
      .bind(data.requestKey)
      .first();
    assert.equal(row?.resolved_schedule_id, kind === "deletion" ? replacement.id : a);
    assert.equal(row?.event_schedule_id, kind === "deletion" ? replacement.id : null);
    assert.equal(row?.outcome, "settings_changed");
    await patch(`/api/owner/schedules/${a}/weekly`, settings.schedule);
    await patch("/api/owner/conflict-calendars", { conflictCalendarIds: null });
    await assert.rejects(s.create(data), /settings_changed/);
    assert.deepEqual(
      await f.db.prepare("SELECT * FROM booking_command WHERE request_key=?").bind(data.requestKey).first(),
      row
    );
  }
  await patch("/api/owner/events/default/schedule", { scheduleId: a });
  for (const kind of ["name", "unrelated", "explicit-default"]) {
    race(async () => {
      if (kind === "name") return patch(`/api/owner/schedules/${a}`, { name: "New name" });
      if (kind === "unrelated")
        return patch(`/api/owner/schedules/${b.id}/weekly`, { timeZone: "Asia/Tokyo", rules: [] });
      return patch(`/api/owner/schedules/${b.id}/default`, {});
    });
    assert.equal((await s.create(input(f.now() + (24 + count++ * 2) * hour))).status, "confirmed");
  }
  assert.equal(f.calendar.writes.length, 3);
  await assert.rejects(
    f.db.prepare("UPDATE booking_command SET resolved_schedule_id=NULL WHERE outcome='accepted'").run(),
    /idempotency_mismatch/
  );
  await assert.rejects(
    f.db.prepare("UPDATE booking_command SET event_schedule_id=NULL WHERE outcome='accepted'").run(),
    /idempotency_mismatch/
  );
});

test("deletion keeps a valid deterministic default and clears assignments atomically including removed events", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const catalog = () => f.request("/api/owner/schedules", { headers: f.ownerHeaders }).then((r) => read(r));
  const a = (await catalog()).defaultScheduleId;
  const b = await read(
    await f.send(`/api/owner/schedules/${a}/duplicate`, { name: "B" }, f.ownerHeaders),
    201
  );
  const c = await read(
    await f.send(`/api/owner/schedules/${a}/duplicate`, { name: "C" }, f.ownerHeaders),
    201
  );
  const e = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  await read(await f.send(`/api/owner/events/${e.id}/schedule`, { scheduleId: a }, f.ownerHeaders, "PATCH"));
  await read(await f.send(`/api/owner/events/${e.id}`, undefined, f.ownerHeaders, "DELETE"));
  const tombstone = await f.db
    .prepare("SELECT json,lifecycle,version FROM event_type WHERE id=?")
    .bind(e.id)
    .first();
  await read(await f.send(`/api/owner/schedules/${a}`, undefined, f.ownerHeaders, "DELETE"));
  assert.equal((await catalog()).defaultScheduleId, b.id);
  assert.deepEqual(
    await f.db.prepare("SELECT json,lifecycle,version FROM event_type WHERE id=?").bind(e.id).first(),
    tombstone
  );
  assert.equal(
    await f.db.prepare("SELECT schedule_id FROM event_type WHERE id=?").bind(e.id).first("schedule_id"),
    null
  );
  await read(await f.send(`/api/owner/schedules/${a}`, undefined, f.ownerHeaders, "DELETE"));
  await read(await f.request(`/api/owner/schedules/${a}`, { headers: f.ownerHeaders }), 404);
  const results = await Promise.all(
    [b, c].map((x) => f.send(`/api/owner/schedules/${x.id}`, undefined, f.ownerHeaders, "DELETE"))
  );
  assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
  const remaining = (await catalog()).defaultScheduleId;
  await assert.rejects(f.db.prepare("DELETE FROM availability_schedule").run(), /final_schedule/);
  const d = await read(
    await f.send(`/api/owner/schedules/${remaining}/duplicate`, { name: "D" }, f.ownerHeaders),
    201
  );
  await Promise.all([
    f.send(`/api/owner/schedules/${d.id}`, undefined, f.ownerHeaders, "DELETE"),
    f.send("/api/owner/events/default/schedule", { scheduleId: d.id }, f.ownerHeaders, "PATCH"),
  ]);
  assert.deepEqual((await f.db.prepare("PRAGMA foreign_key_check").all()).results, []);
  assert.equal(
    await f.db.prepare("SELECT schedule_id FROM event_type WHERE id='default'").first("schedule_id"),
    null
  );
  const before = await f.db.prepare("SELECT * FROM organizer_settings").first();
  await read(
    await f.send(`/api/owner/events/${e.id}/schedule`, { scheduleId: remaining }, f.ownerHeaders, "PATCH"),
    404
  );
  await read(
    await f.send("/api/owner/events/default/schedule", { scheduleId: d.id }, f.ownerHeaders, "PATCH"),
    404
  );
  await read(await f.send("/api/owner/events/default", undefined, f.ownerHeaders, "DELETE"));
  await read(await f.send("/api/owner", settings, f.ownerHeaders, "PUT"), 404);
  assert.deepEqual(await f.db.prepare("SELECT * FROM organizer_settings").first(), before);
});

test("schedule APIs enforce private strict transport and never accept booking provenance", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const id = (await read(await f.request("/api/owner/schedules", { headers: f.ownerHeaders })))
    .defaultScheduleId;
  for (const path of ["/api/owner/schedules", `/api/owner/schedules/${id}`]) {
    await read(await f.request(path), 401);
    await read(await f.request(`${path}?extra=1`, { headers: f.ownerHeaders }), 400);
    await read(await f.send(path, { name: "X" }, { ...f.ownerHeaders, Origin: "https://foreign.test" }), 403);
  }
  for (const value of [{}, { name: "" }, { name: "X", extra: true }, { name: 7 }, { name: "X".repeat(101) }])
    await read(await f.send("/api/owner/schedules", value, f.ownerHeaders), 400);
  await read(
    await f.send(`/api/owner/schedules/${id}/default`, { extra: true }, f.ownerHeaders, "PATCH"),
    400
  );
  await read(await f.send(`/api/owner/schedules/${id}`, {}, f.ownerHeaders, "DELETE"), 400);
  await read(
    await f.send(
      "/api/owner/events/default/schedule",
      { scheduleId: id, extra: true },
      f.ownerHeaders,
      "PATCH"
    ),
    400
  );
  for (const key of ["scheduleId", "eventScheduleId", "resolvedScheduleId"])
    await read(await f.send("/api/bookings", { ...input(f.now() + 9 * hour), [key]: id }), 400);
  await read(await f.request("/api/owner/schedules/unknown", { headers: f.ownerHeaders }), 404);
  await read(
    await f.send(
      `/api/owner/schedules/${id}/weekly`,
      { timeZone: "Invalid/Zone", rules: [] },
      f.ownerHeaders,
      "PATCH"
    ),
    400
  );
  const unused = await read(
    await f.send("/api/owner/schedules", { name: "Private unused marker" }, f.ownerHeaders),
    201
  );
  for (const path of ["/api/public", "/api/events/default"]) {
    const text = JSON.stringify(await read(await f.request(path)));
    for (const privateValue of [
      unused.id,
      unused.name,
      "scheduleId",
      "defaultScheduleId",
      "resolvedScheduleId",
    ])
      assert.equal(text.includes(privateValue), false);
  }
  assert.equal(f.calendar.writes.length, 0);
});

test("fresh moves use the event schedule and historical duration while all schedules share holds and owner policy", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const s = service(f);
  const patch = (path: string, value: unknown) =>
    f.send(path, value, f.ownerHeaders, "PATCH").then((r) => read(r));
  const event = await read(await f.send("/api/owner/events", details, f.ownerHeaders), 201);
  const a = (await read(await f.request("/api/owner/schedules", { headers: f.ownerHeaders })))
    .defaultScheduleId;
  const b = await read(
    await f.send(`/api/owner/schedules/${a}/duplicate`, { name: "Tokyo" }, f.ownerHeaders),
    201
  );
  await patch(`/api/owner/events/${event.id}/schedule`, { scheduleId: b.id });
  await patch(`/api/owner/events/${event.id}/booking-rules`, {
    intervalMinutes: 30,
    beforeMinutes: 0,
    afterMinutes: 0,
    noticeMinutes: 0,
    disableCancelling: false,
    disableRescheduling: false,
  });
  await patch("/api/owner/conflict-calendars", { conflictCalendarIds: [] });
  const original = await s.create(input(f.now() + 9 * hour), event.id);
  assert.ok(original.manageToken);
  await patch(`/api/owner/events/${event.id}`, { ...details, durationMinutes: 90 });
  await patch(`/api/owner/schedules/${b.id}/weekly`, { timeZone: "Asia/Tokyo", rules: [] });
  for (const actor of ["owner", "attendee"]) {
    const change = {
      action: "reschedule",
      requestKey: crypto.randomUUID(),
      version: 1,
      start: f.now() + 12 * hour,
    };
    await assert.rejects(
      actor === "owner"
        ? s.ownerChange(original.id, change)
        : s.change(original.id, original.manageToken, change),
      /invalid_slot/
    );
  }
  await patch(`/api/owner/schedules/${b.id}/weekly`, { ...settings.schedule, timeZone: "Asia/Tokyo" });
  let current = original;
  for (const actor of ["owner", "attendee"]) {
    const change = {
      action: "reschedule",
      requestKey: crypto.randomUUID(),
      version: current.version,
      start: current.start + 2 * hour,
    };
    current =
      actor === "owner"
        ? await s.ownerChange(original.id, change)
        : await s.change(original.id, original.manageToken, change);
    assert.equal(current.end - current.start, hour / 2);
  }
  f.calendar.cutAfter = "update";
  const move = {
    action: "reschedule",
    requestKey: crypto.randomUUID(),
    version: current.version,
    start: current.start + 2 * hour,
  };
  const pending = await s.ownerChange(current.id, move);
  assert.equal(pending.pendingAction, "reschedule");
  for (const start of [current.start, move.start]) await assert.rejects(s.create(input(start)), /conflict/);
  current = await s.ownerChange(current.id, move);
  assert.equal(current.status, "confirmed");
  const fallback = await s.create(input(original.start));
  assert.equal(fallback.status, "confirmed");
  for (const row of (await s.ownerPage({ filter: "all", before: null })).bookings) {
    assert.notEqual(row.disableCancelling, true);
    assert.notEqual(row.disableRescheduling, true);
  }
  await read(await f.send(`/api/owner/events/${event.id}`, undefined, f.ownerHeaders, "DELETE"));
  const removed = (await s.ownerPage({ filter: "all", before: null })).bookings.find(
    (row) => row.id === original.id
  );
  assert.equal(removed?.disableRescheduling, true);
  assert.equal(removed?.disableCancelling, false);
  await s.ownerChange(current.id, {
    action: "cancel",
    requestKey: crypto.randomUUID(),
    version: current.version,
    cancellationReason: "Release",
  });
  assert.equal((await s.create(input(current.start))).status, "confirmed");
  await f.db.prepare("UPDATE availability_schedule SET json='{}' WHERE id=?").bind(b.id).run();
  const corrupt = (await s.ownerPage({ filter: "all", before: null })).bookings.find(
    (row) => row.id === original.id
  );
  assert.equal(corrupt?.disableRescheduling, true);
  assert.equal(corrupt?.disableCancelling, true);
});
