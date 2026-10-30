import assert from "node:assert/strict";
import { test } from "node:test";
import { parseSettings, SettingsError } from "../src/domain/settings.ts";
import { getSettings, saveConflictCalendars, saveSettings } from "../src/server/settings.ts";
import { apiFixture, hour, settings, storedSettings } from "./fixtures/api.ts";

test("conflict selection preserves legacy bytes and validates exact sorted IDs", () => {
  assert.equal(JSON.stringify(parseSettings(settings)), JSON.stringify(settings));
  for (const ids of [[], ["primary"], ["a", "Z", "A"], Array.from({ length: 50 }, (_, i) => `id-${i}`)]) {
    assert.deepEqual(
      parseSettings({ ...settings, conflictCalendarIds: ids }).conflictCalendarIds,
      [...ids].sort()
    );
  }
  for (const ids of [
    null,
    "primary",
    [null],
    [1],
    [""],
    [" "],
    ["padded "],
    ["a\u0080b"],
    ["a\u0000b"],
    ["x".repeat(1025)],
    ["a", "a"],
    Array.from({ length: 51 }, (_, i) => `id-${i}`),
  ]) {
    assert.throws(() => parseSettings({ ...settings, conflictCalendarIds: ids }), SettingsError);
  }
});

test("owner conflict reset and empty selection persist canonical settings without discovery", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const response = await f.send(
    "/api/owner/conflict-calendars",
    { conflictCalendarIds: [] },
    f.ownerHeaders,
    "PATCH"
  );
  assert.equal(response.status, 200);
  assert.deepEqual(
    (await (await f.request("/api/owner", { headers: f.ownerHeaders })).json()).settings.conflictCalendarIds,
    []
  );
  const realFetch = globalThis.fetch;
  t.after(() => {
    globalThis.fetch = realFetch;
  });
  let calls = 0,
    status = 200,
    partial = false;
  globalThis.fetch = async (input, init) => {
    if (!String(input).startsWith("https://www.googleapis.com/")) return realFetch(input, init);
    calls++;
    const page = new URL(String(input)).searchParams.has("pageToken");
    return Response.json(
      status !== 200
        ? { error: "PRIVATE" }
        : partial && page
          ? { items: null }
          : {
              items: [
                { id: "Owner@Email.test", primary: true, summary: "Private name", accessRole: "owner" },
                { id: "PrivateCalendar", summary: "Private name", accessRole: "freeBusyReader" },
              ],
              ...(partial ? { nextPageToken: "second" } : {}),
            },
      { status }
    );
  };
  const path = "/api/owner/conflict-calendars";
  const raw = () => storedSettings(f.db);
  const original = await raw();
  for (const value of [
    {},
    { conflictCalendarIds: [], extra: 1 },
    { conflictCalendarIds: ["unknown"] },
    { conflictCalendarIds: ["Owner@Email.test"] },
  ])
    assert.equal((await f.send(path, value, f.ownerHeaders, "PATCH")).status, 400);
  assert.deepEqual(await raw(), original);
  const beforeAuth = calls;
  for (const headers of [
    {},
    { Authorization: `Bearer ${"A".repeat(43)}` },
    { Cookie: `flare_session=${"A".repeat(43)}` },
    { ...f.ownerHeaders, Origin: "https://foreign.test" },
  ])
    assert.ok(
      [401, 403].includes(
        (await f.send(path, { conflictCalendarIds: ["PrivateCalendar"] }, headers, "PATCH")).status
      )
    );
  assert.equal(calls, beforeAuth);
  for (const value of [403, 429, 200]) {
    status = value;
    partial = value === 200;
    assert.equal(
      (await f.send(path, { conflictCalendarIds: ["PrivateCalendar"] }, f.ownerHeaders, "PATCH")).status,
      503
    );
    assert.equal(
      (
        await f.send(
          "/api/owner",
          { ...settings, conflictCalendarIds: ["PrivateCalendar"] },
          f.ownerHeaders,
          "PUT"
        )
      ).status,
      503
    );
    assert.deepEqual(await raw(), original);
  }
  status = 200;
  partial = false;
  assert.equal(
    (await f.send(path, { conflictCalendarIds: ["primary", "PrivateCalendar"] }, f.ownerHeaders, "PATCH"))
      .status,
    200
  );
  assert.deepEqual((await (await f.request(path, { headers: f.ownerHeaders })).json()).conflictCalendarIds, [
    "PrivateCalendar",
    "primary",
  ]);
  let bookingNumber = 0;
  for (const location of ["Room 東京 😀", "Room\u0000tail", "Room\ud800tail"]) {
    await saveSettings(f.db, { ...settings, event: { ...settings.event, location } });
    const before = await raw();
    await Promise.all([
      saveConflictCalendars(f.db, ["primary", "PrivateCalendar"]),
      f.send(
        "/api/owner",
        { slug: "intro", title: "Concurrent", description: "", durationMinutes: 30 },
        f.ownerHeaders,
        "PATCH"
      ),
      f.send(
        "/api/owner/schedule",
        { ...settings.schedule, timeZone: "Asia/Manila" },
        f.ownerHeaders,
        "PATCH"
      ),
      f.send("/api/owner/overrides", { overrides: [] }, f.ownerHeaders, "PATCH"),
      f.send(
        "/api/owner/booking-rules",
        {
          intervalMinutes: 5,
          beforeMinutes: 0,
          afterMinutes: 0,
          noticeMinutes: 0,
          disableCancelling: false,
          disableRescheduling: false,
        },
        f.ownerHeaders,
        "PATCH"
      ),
    ]);
    const current = await getSettings(f.db),
      after = await raw();
    assert.equal(after?.version, (before?.version ?? 0) + 5);
    assert.equal(after?.json, JSON.stringify(current));
    assert.equal(current.event.location, location);
    assert.equal(current.event.title, "Concurrent");
    assert.equal(current.schedule.timeZone, "Asia/Manila");
    assert.deepEqual(current.schedule.overrides, []);
    assert.deepEqual(current.conflictCalendarIds, ["PrivateCalendar", "primary"]);
    const created = await f.send("/api/bookings", {
      requestKey: crypto.randomUUID(),
      start: f.now() + ++bookingNumber * hour,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    });
    assert.equal(created.status, 201, await created.text());
  }
  status = 403;
  for (const ids of [[], null]) {
    const before = calls;
    assert.equal((await f.send(path, { conflictCalendarIds: ids }, f.ownerHeaders, "PATCH")).status, 200);
    assert.equal(calls, before);
    assert.equal((await getSettings(f.db)).conflictCalendarIds === undefined, ids === null);
  }
  await saveConflictCalendars(f.db, ["primary"]);
  assert.equal(
    (await f.send("/api/owner", { ...settings, conflictCalendarIds: null }, f.ownerHeaders, "PUT")).status,
    400
  );
  assert.deepEqual((await getSettings(f.db)).conflictCalendarIds, ["primary"]);
  assert.equal((await f.send("/api/owner", settings, f.ownerHeaders, "PUT")).status, 200);
  assert.equal((await raw())?.json, JSON.stringify(settings));
  for (const ids of [[], null, ["primary"]]) {
    await f.db.prepare("DELETE FROM organizer_settings").run();
    await assert.rejects(saveConflictCalendars(f.db, ids), SettingsError);
    assert.equal(await raw(), null, "Missing authoritative preferences cannot silently reset");
  }
  await f.db.prepare("UPDATE owner_session SET expires_at=0").run();
  const beforeExpired = calls;
  assert.equal(
    (await f.send(path, { conflictCalendarIds: ["PrivateCalendar"] }, f.ownerHeaders, "PATCH")).status,
    401
  );
  await f.db.prepare("DELETE FROM owner_session").run();
  assert.equal(
    (await f.send(path, { conflictCalendarIds: ["PrivateCalendar"] }, f.ownerHeaders, "PATCH")).status,
    401
  );
  assert.equal(calls, beforeExpired);
});

test("selection changes during fresh admission are fenced by the current canonical row", async (t) => {
  const f = await apiFixture();
  t.after(f.close);
  const busy = f.calendar.busy.bind(f.calendar);
  let changed = false;
  f.calendar.busy = async (...args) => {
    if (!changed) {
      changed = true;
      await saveConflictCalendars(f.db, []);
    }
    return busy(...args);
  };
  const response = await f.send("/api/bookings", {
    requestKey: "selection-admission-race",
    start: f.now() + 9 * hour,
    name: "Guest",
    email: "guest@example.test",
    timeZone: "UTC",
  });
  const result = await response.json();
  assert.equal(result.error, "settings_changed");
  assert.equal(response.status, 409);
  assert.equal(f.calendar.writes.length, 0);
  assert.equal(await f.db.prepare("SELECT count(*) AS n FROM booking").first("n"), 0);
  assert.deepEqual((await getSettings(f.db)).conflictCalendarIds, []);
});
