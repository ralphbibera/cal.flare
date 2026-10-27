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
import type { Interval } from "../src/domain/scheduling.ts";
import { defaultSettings } from "../src/domain/settings.ts";
import { BookingAvailability } from "../src/server/booking-availability.ts";
import type { Booking, BookingSnapshot } from "../src/server/booking-model.ts";

test("booking availability combines visitor rounding, D1 holds and fresh calendar checks", async () => {
  const require = createRequire(import.meta.url);
  const wrangler = join(dirname(require.resolve("wrangler/package.json")), "bin/wrangler.js");
  const configPath = fileURLToPath(new URL("../wrangler.jsonc", import.meta.url));
  const temporary = await mkdtemp(join(tmpdir(), "flare-booking-slots-"));
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
    const db = platform.env.DB.withSession("first-primary");
    const from = Date.parse("2030-01-07T09:00:00Z"),
      to = from + 3 * 3_600_000,
      minute = 60_000;
    let now = from - 86_400_000;
    const settings = structuredClone(defaultSettings);
    Object.assign(settings.event, { intervalMinutes: 60, noticeMinutes: 0 });
    settings.schedule.rules = [{ weekday: 1, startMinute: 540, endMinute: 720 }];
    const calls: [string, string, string | undefined][] = [];
    let remote: Interval[] = [],
      failure = false;
    const calendar = {
      async busy(start: string, end: string, exclude?: string) {
        calls.push([start, end, exclude]);
        if (failure) throw new Error("calendar unavailable");
        return remote;
      },
    };
    const availability = new BookingAvailability(db, calendar, settings, () => now);
    const starts = async (zone: string) => (await availability.slots(from, to, zone)).map((x) => x.start);
    assert.deepEqual(await starts("UTC"), [from, from + 60 * minute, from + 120 * minute]);
    assert.deepEqual(await starts("Asia/Kolkata"), [
      from + 30 * minute,
      from + 90 * minute,
      from + 150 * minute,
    ]);
    const desired: BookingSnapshot = {
      id: "a".repeat(64),
      start: from,
      end: from + 30 * minute,
      title: "Intro",
      description: "",
      timeZone: "UTC",
      attendee: { name: "Guest", email: "guest@example.com" },
      privateMetadata: {},
    };
    await db
      .prepare(`INSERT INTO booking(id,version,state,token_hash,initial_json) VALUES(?,1,'active',?,?)`)
      .bind(desired.id, "token-hash", JSON.stringify(desired))
      .run();
    await db
      .prepare("INSERT INTO booking_reservation VALUES(?, 'current', ?, ?)")
      .bind(desired.id, from, from + 30 * minute)
      .run();
    await db
      .prepare("INSERT INTO booking_reservation VALUES(?, 'candidate', ?, ?)")
      .bind(desired.id, from + 120 * minute, from + 150 * minute)
      .run();
    remote = [{ start: from + 60 * minute, end: from + 90 * minute }];
    assert.deepEqual(await starts("UTC"), []);
    remote = [];
    assert.deepEqual(await starts("UTC"), [from + 60 * minute]);
    const booking = await db.prepare("SELECT * FROM booking WHERE id=?").bind(desired.id).first<Booking>();
    assert.ok(booking);
    assert.deepEqual(
      (await availability.slots(from, to, "UTC", booking)).map((x) => x.start),
      [from, from + 60 * minute, from + 120 * minute]
    );
    assert.equal(calls.at(-1)?.[2], desired.id);
    const long = { ...booking, confirmed_json: JSON.stringify({ ...desired, end: from + 90 * minute }) };
    assert.deepEqual(
      (await availability.slots(from, to, "UTC", long)).map((x) => x.start),
      [from, from + 60 * minute]
    );
    assert.equal(await availability.condition(desired, desired.id), "accepted");
    assert.equal(calls.at(-1)?.[2], desired.id);
    assert.equal(await availability.condition({ ...desired, timeZone: "Asia/Kolkata" }), "invalid_slot");
    assert.equal(
      await availability.condition({
        ...desired,
        start: from + 30 * minute,
        end: from + 60 * minute,
        timeZone: "Asia/Kolkata",
      }),
      "accepted"
    );
    remote = [{ start: desired.end, end: desired.end + minute }];
    assert.equal(await availability.condition(desired), "accepted");
    remote = [{ start: desired.end - 1, end: desired.end + minute }];
    assert.equal(await availability.condition(desired), "conflict");
    const buffered = new BookingAvailability(
      db,
      calendar,
      { ...settings, event: { ...settings.event, beforeMinutes: 5, afterMinutes: 10 } },
      () => now
    );
    remote = [{ start: desired.end + 9 * minute, end: desired.end + 11 * minute }];
    assert.equal(await buffered.condition(desired), "conflict");
    assert.deepEqual(calls.at(-1), [
      new Date(from - 5 * minute).toISOString(),
      new Date(desired.end + 10 * minute).toISOString(),
      undefined,
    ]);
    remote = [];
    const notice = new BookingAvailability(
      db,
      calendar,
      { ...settings, event: { ...settings.event, noticeMinutes: 60 } },
      () => now
    );
    now = from - 60 * minute;
    assert.equal(await notice.condition(desired), "accepted");
    now++;
    assert.equal(await notice.condition(desired), "invalid_slot");
    now = from - 86_400_000;
    const count = calls.length;
    await assert.rejects(availability.slots(from, to, "Invalid/Zone"), /invalid_input/);
    await assert.rejects(availability.slots(from, from, "UTC"), /invalid_range/);
    await assert.rejects(availability.slots(from, from + 63 * 86_400_000 + 1, "UTC"), /invalid_range/);
    assert.equal(
      await availability.condition({ ...desired, start: from - 60 * minute, end: from - 30 * minute }),
      "invalid_slot"
    );
    assert.equal(calls.length, count);
    now = from + 1;
    assert.equal(await availability.condition(desired), "invalid_slot");
    failure = true;
    await assert.rejects(availability.slots(from, to, "UTC"), /calendar unavailable/);
    now = from - 86_400_000;
    await assert.rejects(availability.condition(desired), /calendar unavailable/);
  } finally {
    try {
      await platform?.dispose();
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
});
