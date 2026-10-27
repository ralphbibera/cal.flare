import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import process from "node:process";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { getPlatformProxy } from "wrangler";
import { defaultSettings } from "../src/domain/settings.ts";
import { BookingAvailability } from "../src/server/booking-availability.ts";
import { BookingDelivery } from "../src/server/booking-delivery.ts";
import type { Action, Booking, BookingSnapshot, Calendar, Command } from "../src/server/booking-model.ts";
import type { CalendarEvent, EventInput } from "../src/server/google.ts";
import { GoogleCalendarError } from "../src/server/google.ts";

test("durable Calendar dispatch reconciles ambiguity and fences retries without releasing holds", async () => {
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "flare-booking-delivery-"));
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  try {
    for (const name of ["0002_settings.sql", "0003_bookings.sql"]) {
      await promisify(execFile)(
        process.execPath,
        [
          wrangler,
          "d1",
          "execute",
          "calflare",
          "--local",
          "--persist-to",
          temporary,
          "--file",
          fileURLToPath(new URL(`../migrations/${name}`, import.meta.url)),
          "--config",
          configPath,
        ],
        { env: { ...process.env, WRANGLER_SEND_METRICS: "false" } }
      );
    }
    platform = await getPlatformProxy<{ DB: D1Database }>({
      configPath,
      persist: { path: join(temporary, "v3") },
      remoteBindings: false,
    });
    const db = platform.env.DB.withSession("first-primary"),
      settings = structuredClone(defaultSettings);
    Object.assign(settings.event, { intervalMinutes: 5, noticeMinutes: 0 });
    settings.schedule.rules = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      startMinute: 0,
      endMinute: 1440,
    }));
    const policy = JSON.stringify(settings);
    await db.prepare("INSERT INTO organizer_settings VALUES('owner', ?, 1)").bind(policy).run();
    const hour = 3_600_000;
    let now = Date.UTC(2030, 0, 1),
      serial = 0,
      inserts = 0,
      deletes = 0;
    let insertMode: "ok" | "lost" | "absent" | "reject" | "auth" = "ok";
    let updateMode: "ok" | "before" | "after" = "ok",
      loseDelete = false;
    let beforeInsert: (() => Promise<void>) | undefined;
    const updates: string[] = [],
      events = new Map<string, CalendarEvent>();
    const event = (input: EventInput): CalendarEvent => ({
      id: input.id,
      etag: `"${++serial}"`,
      start: { dateTime: new Date(input.start).toISOString() },
      end: { dateTime: new Date(input.end).toISOString() },
      summary: input.title,
      description: input.description,
      attendees: [{ email: input.attendee.email, displayName: input.attendee.name }],
      extendedProperties: { private: { ...input.privateMetadata } },
    });
    const calendar: Calendar = {
      async busy() {
        return [];
      },
      async get(id) {
        return events.get(id) ?? null;
      },
      async insert(input) {
        inserts++;
        await beforeInsert?.();
        if (insertMode === "reject") throw new GoogleCalendarError("retryable", 429, "Rejected");
        if (insertMode === "auth") throw new GoogleCalendarError("retryable", 0, "Not dispatched", false);
        if (insertMode === "absent") throw new GoogleCalendarError("ambiguous", 0, "Unresolved");
        assert.equal(events.has(input.id), false);
        const result = event(input);
        events.set(input.id, result);
        if (insertMode === "lost") throw new GoogleCalendarError("ambiguous", 0, "Lost acknowledgment");
        return { id: result.id, etag: result.etag };
      },
      async update(id, etag, input) {
        updates.push(etag);
        assert.equal(events.get(id)?.etag, etag);
        if (updateMode === "before") throw new GoogleCalendarError("ambiguous", 0, "Unresolved");
        const result = event({ ...input, id });
        events.set(id, result);
        if (updateMode === "after") throw new GoogleCalendarError("ambiguous", 0, "Lost acknowledgment");
        return { id, etag: result.etag };
      },
      async delete(id, etag) {
        deletes++;
        assert.equal(events.get(id)?.etag, etag);
        events.delete(id);
        if (loseDelete) throw new GoogleCalendarError("ambiguous", 0, "Lost acknowledgment");
      },
    };
    const availability = new BookingAvailability(db, calendar, settings, () => now);
    const delivery = () => new BookingDelivery({ db, calendar, availability, now: () => now });
    const desired = (id: string, start: number, operation: string): BookingSnapshot => ({
      id,
      start,
      end: start + hour / 2,
      timeZone: "UTC",
      title: "Intro",
      description: "",
      attendee: { name: "Guest", email: "guest@example.com" },
      privateMetadata: { application: "calflare", booking: id, operation },
    });
    const admit = async (id: string, input: BookingSnapshot, action: Action = "create", version = 0) => {
      await db
        .prepare(`INSERT INTO booking_command(id,request_key,booking_id,action,payload,expected_version,
        desired_json,settings_json,token_hash,occupied_start,occupied_end,precondition,due)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,'accepted',?)`)
        .bind(
          id,
          id,
          input.id,
          action,
          JSON.stringify(input),
          version,
          JSON.stringify(input),
          policy,
          "token-hash",
          input.start,
          input.end,
          now
        )
        .run();
      assert.equal((await command(id))?.outcome, "accepted");
    };
    const command = (id: string) =>
      db.prepare("SELECT * FROM booking_command WHERE id=?").bind(id).first<Command & { terminal: number }>();
    const booking = (id: string) => db.prepare("SELECT * FROM booking WHERE id=?").bind(id).first<Booking>();
    const holds = async (id: string) =>
      (
        await db
          .prepare("SELECT start,end FROM booking_reservation WHERE booking_id=? ORDER BY start")
          .bind(id)
          .all()
      ).results;
    const first = desired("a".repeat(64), now + 10 * hour, "create-first");
    await admit("create-first", first);
    await Promise.all([delivery().process("create-first"), delivery().process("create-first")]);
    assert.equal((await booking(first.id))?.state, "active");
    assert.equal(inserts, 1);
    assert.equal((await command("create-first"))?.terminal, 1);
    await delivery().process("create-first");
    assert.equal(inserts, 1);
    const remote = events.get(first.id);
    assert.ok(remote);
    remote.etag = '"rsvp"';
    remote.attendees[0].responseStatus = "accepted";
    const moved = desired(first.id, first.start + 2 * hour, "move-first");
    await admit("move-first", moved, "reschedule", 1);
    updateMode = "before";
    await delivery().process("move-first");
    assert.equal((await command("move-first"))?.base_etag, '"rsvp"');
    assert.deepEqual(await holds(first.id), [
      { start: first.start, end: first.end },
      { start: moved.start, end: moved.end },
    ]);
    updateMode = "after";
    now += 120_000;
    await delivery().recover();
    assert.deepEqual(updates, ['"rsvp"', '"rsvp"']);
    assert.equal((await command("move-first"))?.execution, "sent");
    now += 120_000;
    await delivery().recover();
    assert.equal((await booking(first.id))?.confirmed_json, JSON.stringify(moved));
    assert.equal(updates.length, 2, "Applied move is reconciled without another update");
    assert.deepEqual(await holds(first.id), [{ start: moved.start, end: moved.end }]);
    await admit(
      "cancel-first",
      { ...moved, privateMetadata: { ...moved.privateMetadata, operation: "cancel-first" } },
      "cancel",
      2
    );
    loseDelete = true;
    await delivery().process("cancel-first");
    assert.equal((await holds(first.id)).length, 1);
    now += 120_000;
    await delivery().recover();
    assert.equal((await booking(first.id))?.state, "cancelled");
    assert.equal(deletes, 1);
    assert.deepEqual(await holds(first.id), []);

    const lost = desired("b".repeat(64), first.start + 4 * hour, "lost");
    await admit("lost", lost);
    insertMode = "lost";
    await delivery().process("lost");
    assert.equal((await command("lost"))?.execution, "sent");
    assert.equal((await booking(lost.id))?.state, "unconfirmed");
    now += 120_000;
    const beforeLost = inserts;
    await delivery().recover();
    assert.equal((await booking(lost.id))?.state, "active");
    assert.equal(inserts, beforeLost);
    const absent = desired("c".repeat(64), first.start + 6 * hour, "absent");
    await admit("absent", absent);
    insertMode = "absent";
    await delivery().process("absent");
    now += 120_000;
    const beforeAbsent = inserts;
    await delivery().recover();
    assert.equal((await command("absent"))?.error, "insert_unresolved");
    assert.equal((await holds(absent.id)).length, 1);
    assert.equal(inserts, beforeAbsent);
    for (const mode of ["reject", "auth"] as const) {
      const input = desired(
        mode === "reject" ? "d".repeat(64) : "e".repeat(64),
        first.start + (mode === "reject" ? 8 : 10) * hour,
        mode
      );
      await admit(mode, input);
      insertMode = mode;
      await delivery().process(mode);
      assert.equal((await command(mode))?.execution, "queued");
      const attempts: number = inserts;
      insertMode = "ok";
      now += 120_000;
      await delivery().recover();
      assert.equal((await booking(input.id))?.state, "active");
      assert.equal(inserts, attempts + 1);
    }
    const late = desired("f".repeat(64), first.start + 12 * hour, "late");
    await admit("late", late);
    let release = () => {},
      entered = () => {};
    const waiting = new Promise<void>((resolve) => {
      entered = resolve;
    });
    beforeInsert = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        entered();
      });
    const outstanding = delivery().process("late");
    await waiting;
    now += 61_000;
    await delivery().recover();
    assert.equal((await command("late"))?.error, "insert_unresolved");
    release();
    await outstanding;
    beforeInsert = undefined;
    assert.equal((await booking(late.id))?.state, "unconfirmed", "Stale acknowledgment cannot finalize");
    const beforeLate = inserts;
    now += 120_000;
    await delivery().recover();
    assert.equal((await booking(late.id))?.state, "active");
    assert.equal(inserts, beforeLate);
    const fenced = desired("1".repeat(64), first.start + 14 * hour, "fenced-create");
    await admit("fenced-create", fenced);
    await delivery().process("fenced-create");
    const candidate = desired(fenced.id, fenced.start + hour, "fenced-move");
    await admit("fenced-move", candidate, "reschedule", 1);
    updateMode = "before";
    await delivery().process("fenced-move");
    const fixed = (await command("fenced-move"))?.base_etag;
    const changed = events.get(fenced.id);
    assert.ok(changed);
    changed.etag = '"changed-after-dispatch"';
    changed.attendees[0].responseStatus = "declined";
    const beforeFence = updates.length;
    now += 120_000;
    await delivery().recover();
    assert.equal(updates.length, beforeFence, "Retry cannot adopt a newer ETag after dispatch");
    assert.equal((await command("fenced-move"))?.base_etag, fixed);
    assert.equal((await command("fenced-move"))?.error, "event_changed");
    assert.equal((await holds(fenced.id)).length, 2);
    await assert.rejects(delivery().recover(0));
    await assert.rejects(delivery().recover(101));
  } finally {
    try {
      await platform?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
