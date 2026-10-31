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
import { GoogleCalendarError } from "../src/server/google.ts";
import { saveSettings } from "../src/server/settings.ts";

test("booking service admits, manages and replays bookings safely across competing requests", async () => {
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "flare-booking-service-"));
  let platform: Awaited<ReturnType<typeof getPlatformProxy<{ DB: D1Database }>>> | undefined;
  try {
    for (const name of [
      "0002_settings.sql",
      "0003_bookings.sql",
      "0005_events.sql",
      "0006_event_lifecycle.sql",
      "0007_availability_schedules.sql",
    ]) {
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
    let clock = now;
    let busyGate: (() => Promise<void>) | undefined, inserted: (() => void) | undefined;
    let insertGate: (() => Promise<void>) | undefined,
      updateGate: (() => Promise<void>) | undefined,
      deleteGate: (() => Promise<void>) | undefined,
      insertError: Error | undefined;
    const updateTags: string[] = [],
      deleteTags: string[] = [];
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
        await insertGate?.();
        if (insertError) throw insertError;
        assert.equal(events.has(input.id), false);
        const result = event(input);
        events.set(input.id, result);
        inserted?.();
        return { id: result.id, etag: result.etag };
      },
      async update(id, etag, input) {
        updateTags.push(etag);
        await updateGate?.();
        if (events.get(id)?.etag !== etag)
          throw new GoogleCalendarError("definite", 412, "Event precondition failed");
        const result = event({ ...input, id });
        events.set(id, result);
        return { id, etag: result.etag };
      },
      async delete(id, etag) {
        deleteTags.push(etag);
        await deleteGate?.();
        if (events.get(id)?.etag !== etag)
          throw new GoogleCalendarError("definite", 412, "Event precondition failed");
        events.delete(id);
      },
    };
    const options = { db, calendar, settings, secret: btoa("k".repeat(32)), now: () => clock };
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
    const change = (view: BookingView, action: "reschedule" | "cancel", start?: number) => ({
      action,
      version: view.version,
      requestKey: crypto.randomUUID(),
      ...(start === undefined ? {} : { start }),
    });
    const holds = (id: string) =>
      db.prepare("SELECT count(*) AS n FROM booking_reservation WHERE booking_id=?").bind(id).first("n");
    const counts = () =>
      Promise.all(
        ["booking", "booking_command", "booking_reservation"].map((table) =>
          db.prepare(`SELECT count(*) AS n FROM ${table}`).first("n")
        )
      );
    const beforeAdmission = await counts();
    await db
      .prepare(`CREATE TRIGGER injected_admission BEFORE INSERT ON booking_reservation
      WHEN NEW.start > ${now + 200 * day} BEGIN SELECT RAISE(ABORT,'injected_admission'); END`)
      .run();
    await assert.rejects(service.create(input(now + 210 * day + hour)), /injected_admission/);
    assert.deepEqual(
      await counts(),
      beforeAdmission,
      "Failed admission leaves no command, booking or reservation"
    );
    await db.prepare("DROP TRIGGER injected_admission").run();

    const failedAck = await service.create(input(now + 70 * day + 10 * hour));
    await db
      .prepare(`CREATE TRIGGER injected_finish BEFORE INSERT ON booking_reservation
      WHEN NEW.booking_id='${failedAck.id}' AND NEW.role='current'
      BEGIN SELECT RAISE(ABORT,'injected_finish'); END`)
      .run();
    const moveAck = change(failedAck, "reschedule", failedAck.start + 2 * hour);
    const uncertainAck = await service.change(failedAck.id, token(failedAck), moveAck);
    assert.equal(uncertainAck.status, "attention");
    assert.equal(uncertainAck.start, failedAck.start);
    assert.equal(await holds(failedAck.id), 2);
    await db.prepare("DROP TRIGGER injected_finish").run();
    const beforeAckRetry = updateTags.length;
    const settledAck = await new BookingService(options).retry(failedAck.id, token(failedAck));
    assert.equal(settledAck.status, "confirmed");
    assert.equal(settledAck.start, moveAck.start);
    assert.equal(await holds(failedAck.id), 1);
    assert.equal(
      updateTags.length,
      beforeAckRetry,
      "Finalization recovery observes the applied event without rewriting it"
    );

    let release = () => {},
      announce = () => {};
    const rejectedInsertEntered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    insertGate = () =>
      new Promise<void>((resolve) => {
        release = resolve;
        announce();
      });
    insertError = new GoogleCalendarError("retryable", 429, "Explicit rejection");
    const rejectedInput = input(now + 71 * day + 10 * hour);
    const rejectedInsert = service.create(rejectedInput);
    await rejectedInsertEntered;
    clock += 300_000;
    await new BookingService(options).recover(100);
    insertGate = undefined;
    release();
    const rejectedAfterLease = await rejectedInsert;
    assert.equal(rejectedAfterLease.status, "attention");
    assert.equal(await holds(rejectedAfterLease.id), 1);
    assert.equal(
      await db
        .prepare("SELECT execution FROM booking_command WHERE request_key=?")
        .bind(rejectedInput.requestKey)
        .first("execution"),
      "queued"
    );
    insertError = undefined;
    clock += 300_000;
    const beforeRejectionRetry = inserts;
    await new BookingService(options).recover(100);
    assert.equal((await service.view(rejectedAfterLease.id, token(rejectedAfterLease))).status, "confirmed");
    assert.equal(inserts, beforeRejectionRetry + 1);

    for (const action of ["reschedule", "cancel"] as const) {
      const target = await service.create(input(now + (action === "reschedule" ? 72 : 73) * day + 10 * hour));
      const original = events.get(target.id);
      assert.ok(original);
      const dispatched = new Promise<void>((resolve) => {
        announce = resolve;
      });
      const block = () =>
        new Promise<void>((resolve) => {
          release = resolve;
          announce();
        });
      if (action === "reschedule") updateGate = block;
      else deleteGate = block;
      const request = change(target, action, action === "reschedule" ? target.start + 2 * hour : undefined);
      const inFlight = service.change(target.id, token(target), request);
      await dispatched;
      const responded = {
        ...original,
        etag: `"rsvp-after-${action}"`,
        attendees: original.attendees.map((guest) => ({ ...guest, responseStatus: "accepted" })),
      };
      events.set(target.id, responded);
      clock += 300_000;
      assert.equal(
        (await new BookingService(options).retry(target.id, token(target))).error,
        "event_changed"
      );
      updateGate = undefined;
      deleteGate = undefined;
      release();
      await inFlight;
      assert.deepEqual(
        events.get(target.id),
        responded,
        "Delayed conditional mutation cannot overwrite newer event state"
      );
      const view = await service.view(target.id, token(target));
      assert.equal(view.error, "event_changed");
      assert.equal(view.start, target.start);
      const writes = updateTags.length + deleteTags.length;
      await new BookingService(options).retry(target.id, token(target));
      assert.equal(updateTags.length + deleteTags.length, writes, "Retry cannot adopt a newer ETag");
      assert.equal(await holds(target.id), action === "reschedule" ? 2 : 1);
    }

    const delayed = await service.create(input(now + 74 * day + 10 * hour));
    const oldEntered = new Promise<void>((resolve) => {
      announce = resolve;
    });
    let blocked = false;
    updateGate = async () => {
      if (blocked) return;
      blocked = true;
      await new Promise<void>((resolve) => {
        release = resolve;
        announce();
      });
    };
    const oldMove = change(delayed, "reschedule", delayed.start + 2 * hour);
    const oldRequest = service.change(delayed.id, token(delayed), oldMove);
    await oldEntered;
    const fixedBase = updateTags.at(-1);
    clock += 300_000;
    await new BookingService(options).recover(100);
    const firstRecovered = await service.view(delayed.id, token(delayed));
    assert.equal(firstRecovered.status, "confirmed");
    assert.equal(firstRecovered.start, oldMove.start);
    assert.equal(updateTags.at(-1), fixedBase, "Recovery retries the original conditional ETag");
    const newMove = change(firstRecovered, "reschedule", delayed.start + 4 * hour);
    const newer = await service.change(delayed.id, token(delayed), newMove);
    const newerEvent = structuredClone(events.get(delayed.id));
    assert.ok(newerEvent);
    release();
    await oldRequest;
    updateGate = undefined;
    assert.equal(newer.start, newMove.start);
    assert.deepEqual(
      events.get(delayed.id),
      newerEvent,
      "Old sender cannot overwrite the newer provider event"
    );
    assert.deepEqual(
      await service.view(delayed.id, token(delayed)),
      newer,
      "Old sender cannot acknowledge or overwrite the newer booking"
    );
    const competing = await service.create(input(now + 75 * day + 10 * hour));
    const commands = await Promise.allSettled([
      service.change(
        competing.id,
        token(competing),
        change(competing, "reschedule", competing.start + 2 * hour)
      ),
      service.change(competing.id, token(competing), change(competing, "cancel")),
    ]);
    assert.equal(commands.filter((result) => result.status === "fulfilled").length, 1);
    assert.equal(commands.filter((result) => result.status === "rejected").length, 1);

    for (const offset of [-1, 0, 1]) {
      clock = now;
      const target = await service.create(input(now + (80 + offset) * day + 10 * hour));
      const request = change(target, "cancel"),
        writes = deleteTags.length;
      clock = target.end + offset;
      if (offset <= 0) {
        const cancelled = await service.change(target.id, token(target), request);
        assert.equal(cancelled.status, "cancelled");
        clock = target.end + hour;
        assert.deepEqual(await service.change(target.id, token(target), request), cancelled);
        assert.equal(deleteTags.length, writes + 1);
      } else {
        const original = structuredClone(events.get(target.id));
        const booking = await db.prepare("SELECT * FROM booking WHERE id=?").bind(target.id).first();
        const reservations = await db
          .prepare("SELECT * FROM booking_reservation WHERE booking_id=? ORDER BY role")
          .bind(target.id)
          .all();
        await assert.rejects(service.change(target.id, token(target), request), /invalid_slot/);
        assert.equal(
          await db
            .prepare("SELECT outcome FROM booking_command WHERE request_key=?")
            .bind(request.requestKey)
            .first("outcome"),
          "invalid_slot"
        );
        clock = target.end - 1;
        await assert.rejects(service.change(target.id, token(target), request), /invalid_slot/);
        assert.deepEqual(
          await db.prepare("SELECT * FROM booking WHERE id=?").bind(target.id).first(),
          booking
        );
        assert.deepEqual(
          (
            await db
              .prepare("SELECT * FROM booking_reservation WHERE booking_id=? ORDER BY role")
              .bind(target.id)
              .all()
          ).results,
          reservations.results
        );
        assert.deepEqual(events.get(target.id), original);
        assert.equal(deleteTags.length, writes);
        assert.equal((await service.view(target.id, token(target))).status, "confirmed");
      }
    }
    clock = now;
    const cutoff = await service.create(input(now + 84 * day + 10 * hour));
    const cutoffRequest = change(cutoff, "cancel");
    deleteGate = async () => {
      throw new GoogleCalendarError("retryable", 503, "Temporary provider failure");
    };
    clock = cutoff.end - 1;
    assert.equal((await service.change(cutoff.id, token(cutoff), cutoffRequest)).status, "attention");
    deleteGate = undefined;
    clock = cutoff.end + 1;
    assert.equal((await service.change(cutoff.id, token(cutoff), cutoffRequest)).status, "cancelled");
    assert.equal(events.has(cutoff.id), false);
    assert.equal(
      await db
        .prepare("SELECT count(*) FROM booking_command WHERE booking_id=?")
        .bind(cutoff.id)
        .first("count(*)"),
      2
    );
  } finally {
    try {
      await platform?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
