import assert from "node:assert/strict";
import process from "node:process";
import { calendarExport } from "../src/client/calendar-export.ts";
import { createWorkerFixture } from "./verify-worker.mjs";

export async function verifyConflictCalendars() {
  const now = Date.UTC(2030, 0, 1),
    hour = 3_600_000;
  const f = await createWorkerFixture({ port: 8802, fixedTime: now });
  try {
    const { google, db, read, request, send } = f;
    const owner = await f.login(),
      secondary = "PrivateSelection@group.calendar.google.com";
    google.calendars.push(
      { id: "organizer@example.test", summary: "Private primary name", accessRole: "owner", primary: true },
      { id: secondary, summary: "Private secondary name", accessRole: "freeBusyReader" }
    );
    const configured = {
      ...f.settings,
      event: { ...f.settings.event, location: "Room 東京\u0000tail\ud800" },
    };
    await read(await send("/api/owner", configured, owner, "PUT"));
    const select = async (ids) =>
      read(await send("/api/owner/conflict-calendars", { conflictCalendarIds: ids }, owner, "PATCH"));
    const slots = (start, headers = {}, route = "/api/slots") =>
      request(
        `${route}?${new URLSearchParams({ from: new Date(start).toISOString(), to: new Date(start + hour).toISOString(), timeZone: "UTC" })}`,
        { headers }
      );
    let sequence = 0;
    const input = (start) => ({
      requestKey: `conflict-worker-key-${++sequence}`,
      start,
      name: "Guest",
      email: "guest@example.test",
      timeZone: "UTC",
    });
    const create = (value) => send("/api/bookings", value, { "CF-Connecting-IP": `192.0.2.${sequence}` });
    const busy = (start) => [
      { start: new Date(start).toISOString(), end: new Date(start + hour).toISOString() },
    ];
    const start = now + 9 * hour;
    await read(await send("/api/owner", { ...configured, conflictCalendarIds: [secondary] }, owner, "PUT"));
    await select([secondary]);
    google.events.set("unselected-primary", {
      id: "unselected-primary",
      start: { dateTime: busy(start)[0].start },
      end: { dateTime: busy(start)[0].end },
    });
    google.secondaryBusy.set("unselected", busy(start));
    assert.ok((await read(await slots(start))).slots.length > 0);
    google.secondaryBusy.set(secondary, busy(start));
    assert.deepEqual((await read(await slots(start))).slots, []);
    const rejected = input(start);
    await read(await create(rejected), 409);
    assert.equal(google.writes.length, 0);
    google.secondaryBusy.clear();
    const created = await read(await create(input(start)), 201),
      token = { Authorization: `Bearer ${created.manageToken}` };
    google.events.delete("unselected-primary");
    assert.ok(!JSON.stringify(calendarExport(created, now)).includes(secondary));
    const move = {
      action: "reschedule",
      version: 1,
      requestKey: "secondary-blocked-move",
      start: start + 2 * hour,
    };
    google.secondaryBusy.set(secondary, busy(move.start));
    for (const [route, headers] of [
      [`/api/bookings/${created.id}`, token],
      [`/api/owner/bookings/${created.id}`, owner],
    ]) {
      await read(await send(route, { ...move, requestKey: crypto.randomUUID() }, headers), 409);
    }
    for (const [route, headers] of [
      ["/api/slots", token],
      [`/api/owner/bookings/${created.id}/slots`, owner],
    ])
      assert.deepEqual((await read(await slots(move.start, headers, route))).slots, []);
    google.secondaryBusy.set(secondary, busy(start));
    await select(["primary", secondary]);
    const selfSlots = await request(
      `/api/slots?${new URLSearchParams({ from: new Date(start).toISOString(), to: new Date(start + hour).toISOString(), timeZone: "UTC", bookingId: created.id })}`,
      { headers: token }
    );
    assert.deepEqual((await read(selfSlots)).slots, [], "Mirrored secondary occupancy cannot be subtracted");
    await select([]);
    const reads = google.busyReads.length;
    assert.deepEqual((await read(await slots(start))).slots.map((slot) => slot.start).includes(start), false);
    await read(await create(input(start)), 409);
    assert.equal(google.busyReads.length, reads);
    await select([secondary]);
    const commands = await db.prepare("SELECT count(*) AS n FROM booking_command").first("n");
    const writes = google.writes.length;
    for (const failure of [
      403,
      429,
      "missing",
      { errors: [{ reason: "forbidden" }], busy: [] },
      { busy: [{ start: "bad", end: "bad" }] },
    ]) {
      google.busyFailures.set(secondary, failure);
      for (const response of [await slots(start + 3 * hour), await create(input(start + 3 * hour))]) {
        const error = await read(response, 503);
        assert.ok(!JSON.stringify(error).includes(secondary));
        assert.ok(!JSON.stringify(error).includes("Private"));
      }
    }
    assert.equal(await db.prepare("SELECT count(*) AS n FROM booking_command").first("n"), commands);
    assert.equal(google.writes.length, writes);
    google.busyFailures.clear();
    google.secondaryBusy.clear();
    await read(await create(rejected), 409);
    for (const mode of ["queued", "sent"]) {
      await select([secondary]);
      google.busyReads.length = 0;
      if (mode === "queued") google.busyFailures.set(secondary, { after: 2, status: 403 });
      else google.loseResponseAfter("insert");
      const value = input(start + (mode === "queued" ? 5 : 7) * hour);
      const pending = await read(await create(value), 202);
      assert.equal(pending.status, "attention");
      const row = await db
        .prepare("SELECT execution,settings_json FROM booking_command WHERE request_key=?")
        .bind(value.requestKey)
        .first();
      assert.equal(row.execution, mode);
      assert.deepEqual(JSON.parse(row.settings_json).conflictCalendarIds, [secondary]);
      await select([]);
      google.busyFailures.set(secondary, 403);
      const before = google.writes.length;
      const retry = () => send("/api/owner/retry", { id: pending.id }, owner);
      const recovery = await read(await retry(), mode === "queued" ? 202 : 200);
      assert.equal(recovery.status, mode === "queued" ? "attention" : "confirmed");
      assert.equal(google.writes.length, before);
      if (mode === "queued") {
        assert.ok(
          await db
            .prepare("SELECT count(*) AS n FROM booking_reservation WHERE booking_id=?")
            .bind(pending.id)
            .first("n")
        );
        google.busyFailures.clear();
        await read(await retry());
        assert.equal(google.writes.length, before + 1);
      }
      google.busyFailures.clear();
      const confirmed = await read(await request(`/api/owner/bookings/${pending.id}`, { headers: owner }));
      await select([secondary]);
      google.busyReads.length = 0;
      const moving = {
        action: "reschedule",
        version: confirmed.version,
        requestKey: crypto.randomUUID(),
        start: value.start + hour,
      };
      if (mode === "queued") google.busyFailures.set(secondary, { after: 2, status: 403 });
      else google.loseResponseAfter("update");
      await read(await send(`/api/owner/bookings/${pending.id}`, moving, owner), 202);
      await select([]);
      google.busyFailures.set(secondary, 403);
      const moveWrites = google.writes.length;
      if (mode === "queued") {
        for (const held of [value.start, moving.start]) {
          assert.ok(!(await read(await slots(held))).slots.some((slot) => slot.start === held));
          await read(await create(input(held)), 409);
        }
      }
      await read(await retry(), mode === "queued" ? 202 : 200);
      assert.equal(google.writes.length, moveWrites);
      google.busyFailures.clear();
      const moved = await read(await retry());
      assert.equal(moved.start, moving.start);
      assert.equal(google.writes.length, moveWrites + (mode === "queued" ? 1 : 0));
    }
    await select([secondary]);
    for (const route of [
      "/api/public",
      "/intro",
      "/api/slots?from=2030-01-02T00:00:00Z&to=2030-01-02T01:00:00Z&timeZone=UTC",
      `/api/bookings/${created.id}`,
      `/booking/${created.id}`,
    ]) {
      const response = await request(route, { headers: token }),
        text = await response.text();
      assert.equal(response.status, 200);
      assert.ok(
        !text.includes(secondary) &&
          !text.includes("Private secondary name") &&
          !text.includes("conflictCalendarIds"),
        route
      );
    }
    await select(null);
    const discoveryReads = google.calendarReads.length;
    google.calendars[0].accessRole = "invalid-grant";
    await read(await create(input(start + 20 * hour)), 201);
    assert.equal(google.calendarReads.length, discoveryReads, "Legacy default needs no CalendarList grant");
    await read(
      await send("/api/owner/conflict-calendars", { conflictCalendarIds: [secondary] }, owner, "PATCH"),
      503
    );
    assert.equal(
      (await read(await request("/api/owner", { headers: owner }))).settings.conflictCalendarIds,
      undefined
    );
    assert.deepEqual(google.denied, []);
    assert.deepEqual(f.upstreamFailures, []);
    process.stdout.write(
      "PASS built Worker/D1 selection, secondary aggregation, local holds, frozen recovery, primary writes and public SSR privacy. Google transport is mocked.\n"
    );
  } finally {
    await f.close();
  }
}
