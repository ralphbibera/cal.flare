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
import type { BookingView, Calendar } from "../src/server/booking-model.ts";
import { BookingService } from "../src/server/bookings.ts";
import type { CalendarEvent, EventInput } from "../src/server/google.ts";
import { saveSettings } from "../src/server/settings.ts";

test("booking service admits, manages and replays bookings safely across competing requests", async () => {
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "flare-booking-service-"));
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
    const db = platform.env.DB,
      settings = structuredClone(defaultSettings);
    Object.assign(settings.event, {
      intervalMinutes: 5,
      noticeMinutes: 0,
      beforeMinutes: 5,
      afterMinutes: 5,
    });
    settings.schedule.rules = Array.from({ length: 7 }, (_, weekday) => ({
      weekday,
      startMinute: 0,
      endMinute: 1440,
    }));
    await saveSettings(db, settings);
    const now = Date.UTC(2030, 0, 1),
      hour = 3_600_000,
      day = 24 * hour;
    let serial = 0,
      inserts = 0;
    let busyGate: (() => Promise<void>) | undefined, inserted: (() => void) | undefined;
    const events = new Map<string, CalendarEvent>();
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
      async busy(from, to, exclude) {
        await busyGate?.();
        return [...events.values()]
          .filter((x) => x.id !== exclude)
          .flatMap((x) => {
            assert.ok("dateTime" in x.start && "dateTime" in x.end);
            const start = Date.parse(x.start.dateTime),
              end = Date.parse(x.end.dateTime);
            return start < Date.parse(to) && end > Date.parse(from) ? [{ start, end }] : [];
          });
      },
      async get(id) {
        return events.get(id) ?? null;
      },
      async insert(input) {
        inserts++;
        assert.equal(events.has(input.id), false);
        const result = event(input);
        events.set(input.id, result);
        inserted?.();
        return { id: result.id, etag: result.etag };
      },
      async update(id, etag, input) {
        assert.equal(events.get(id)?.etag, etag);
        const result = event({ ...input, id });
        events.set(id, result);
        return { id, etag: result.etag };
      },
      async delete(id, etag) {
        assert.equal(events.get(id)?.etag, etag);
        events.delete(id);
      },
    };
    const options = { db, calendar, settings, secret: btoa("k".repeat(32)), now: () => now };
    let service = new BookingService(options);
    const input = (start: number) => ({
      requestKey: crypto.randomUUID(),
      start,
      name: "Guest",
      email: "guest@example.com",
      timeZone: "UTC",
    });
    const token = (view: BookingView) => {
      assert.ok(view.manageToken);
      return view.manageToken;
    };
    const firstInput = input(now + 10 * hour),
      first = await service.create(firstInput);
    assert.equal(first.status, "confirmed");
    assert.equal(first.start, firstInput.start);
    assert.equal(inserts, 1);
    assert.deepEqual(await service.create(firstInput), first);
    await assert.rejects(service.create({ ...firstInput, name: "Changed" }), /idempotency_mismatch/);
    for (const method of [service.view, service.retry]) {
      await assert.rejects(method.call(service, first.id, "A".repeat(43)), /not_found/);
      await assert.rejects(Reflect.apply(method, service, [first.id, undefined]), /not_found/);
    }
    await assert.rejects(
      service.availability(now, now + day, "UTC", { id: first.id, token: "A".repeat(43) }),
      /not_found/
    );
    assert.notEqual(
      await db.prepare("SELECT token_hash FROM booking WHERE id=?").bind(first.id).first("token_hash"),
      token(first)
    );
    const invalid = new BookingService({
      ...options,
      settings: { ...settings, event: { ...settings.event, durationMinutes: 9999 } },
    });
    assert.deepEqual(await invalid.create(firstInput), first, "Replay precedes current policy validation");
    const conflict = input(first.start + 5 * 60_000);
    await assert.rejects(service.create(conflict), /conflict/);
    const changed = { ...settings, event: { ...settings.event, durationMinutes: 60 } };
    await saveSettings(db, changed);
    service = new BookingService({ ...options, settings: changed });
    const move = {
      action: "reschedule",
      requestKey: crypto.randomUUID(),
      version: first.version,
      start: first.start + 2 * hour,
    };
    const moved = await service.change(first.id, token(first), move);
    assert.equal(moved.status, "confirmed");
    assert.equal(moved.start, move.start);
    assert.equal(moved.id, first.id);
    assert.equal(moved.end - moved.start, first.end - first.start);
    assert.deepEqual(await service.change(first.id, token(first), move), moved);
    await assert.rejects(
      service.create(conflict),
      /conflict/,
      "Rejection remains durable after its blocker moves"
    );
    const cancel = { action: "cancel", requestKey: crypto.randomUUID(), version: moved.version };
    await assert.rejects(
      service.change(first.id, token(first), {
        ...cancel,
        requestKey: crypto.randomUUID(),
        version: first.version,
      }),
      /stale/
    );
    assert.equal((await service.change(first.id, token(first), cancel)).status, "cancelled");
    assert.equal(events.size, 0);
    assert.equal((await service.ownerList())[0].manageToken, undefined);
    await saveSettings(db, settings);
    service = new BookingService(options);
    let gate = 0;
    const seenInsert = new Promise<void>((resolve) => {
      inserted = resolve;
    });
    busyGate = async () => {
      if (++gate === 2) await seenInsert;
    };
    const sameInput = input(now + day + 10 * hour),
      before = inserts;
    const replayRace = await Promise.all([service.create(sameInput), service.create(sameInput)]);
    busyGate = undefined;
    inserted = undefined;
    assert.equal(replayRace[0].id, replayRace[1].id);
    assert.equal(replayRace[0].manageToken, replayRace[1].manageToken);
    assert.equal(
      inserts,
      before + 1,
      "Different prechecks of the same input converge without another insert"
    );
    assert.equal((await service.retry(replayRace[0].id, token(replayRace[0]))).status, "confirmed");
    for (let round = 0; round < 50; round++) {
      const start = now + (round + 3) * day + 10 * hour;
      const race = await Promise.allSettled([
        service.create(input(start)),
        service.create(input(start + 5 * 60_000)),
      ]);
      assert.equal(race.filter((x) => x.status === "fulfilled").length, 1);
      assert.equal(race.filter((x) => x.status === "rejected").length, 1);
    }
    assert.equal(
      await db
        .prepare(`SELECT count(*) AS n FROM booking_reservation a JOIN booking_reservation b
      ON a.booking_id < b.booking_id WHERE a.start < b.end AND b.start < a.end`)
        .first("n"),
      0
    );
  } finally {
    try {
      await platform?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
