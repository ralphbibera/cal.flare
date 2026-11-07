import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { getServerErrorFromUnknown } from "@calcom/lib/server/getServerErrorFromUnknown";
import { withD1Database } from "@calcom/prisma/d1";
import { BookingStatus } from "@calcom/prisma/enums";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { uuid } from "short-uuid";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { type AddSeatInput, addD1BookingSeat } from "./D1BookingSeatPersistence";

describe("addSeatToBooking on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const originalDate = "2026-11-05T00:00:00.000+00:00";
  const input: AddSeatInput = {
    bookingUid: "seated-slot",
    bookingId: 1,
    bookingStatus: BookingStatus.ACCEPTED,
    seatsPerTimeSlot: 2,
    attendee: { email: "seat@example.invalid", name: "Seat", timeZone: "UTC", locale: "en" },
    seatData: {},
  };
  const addSeat = (overrides: Partial<AddSeatInput> = {}) =>
    withD1Database({ DB: db }, () => addD1BookingSeat({ ...input, ...overrides }, uuid()));
  const seatCount = () =>
    db
      .prepare(`SELECT COUNT(*) FROM "Attendee" a WHERE a."bookingId" = 1
      AND EXISTS (SELECT 1 FROM "BookingSeat" s WHERE s."attendeeId" = a."id")`)
      .first("COUNT(*)");

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-seat-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../../apps/web/cloudflare.config")).default;
    mf = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      resourcePersistencePath: join(persistTo, "v3"),
      workers: [
        {
          config: {
            name: worker.name,
            compatibilityDate: worker.compatibilityDate,
            compatibilityFlags: worker.compatibilityFlags,
            env: { DB: worker.env.DB },
            manifest: {
              mainModule: "worker.js",
              modules: {
                "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
              },
            },
          },
        },
      ],
    });
    db = await mf.getD1Database("DB");
  }, 120_000);

  beforeEach(async () => {
    await db.batch([
      db.prepare('DROP TRIGGER IF EXISTS "fail_seat_insert"'),
      db.prepare('DELETE FROM "Booking"'),
      db
        .prepare(`INSERT INTO "Booking" ("id", "uid", "title", "startTime", "endTime", "updatedAt")
        VALUES (1, 'seated-slot', 'Synthetic seats', ?, ?, ?)`)
        .bind(originalDate, originalDate, originalDate),
    ]);
  });

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("admits exactly one concurrent final-seat attempt and leaves no rejected attendee", async () => {
    await addSeat();
    const results = await Promise.allSettled([addSeat(), addSeat()]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: { statusCode: 409, message: ErrorCode.BookingSeatsFull } });
    expect(await seatCount()).toBe(2);
    expect(await db.prepare('SELECT COUNT(*) FROM "Attendee"').first("COUNT(*)")).toBe(2);
  });

  it("admits both concurrent attempts when capacity remains", async () => {
    expect(
      await Promise.all([addSeat({ seatsPerTimeSlot: 3 }), addSeat({ seatsPerTimeSlot: 3 })])
    ).toHaveLength(2);
    expect(await seatCount()).toBe(2);
  });

  it("rejects a full slot before a missing numeric relation and makes no changes", async () => {
    await addSeat({ seatsPerTimeSlot: 1 });
    const before = await db.prepare('SELECT * FROM "Booking"').all();
    await expect(
      addSeat({ seatsPerTimeSlot: 1, bookingId: 999, bookingStatus: BookingStatus.CANCELLED })
    ).rejects.toMatchObject({ statusCode: 409, message: ErrorCode.BookingSeatsFull });
    expect((await db.prepare('SELECT * FROM "Booking"').all()).results).toEqual(before.results);
    expect(await seatCount()).toBe(1);
  });

  it("allows zero capacity with no seats and with existing seats", async () => {
    const first = await addSeat({ seatsPerTimeSlot: 0 });
    expect(first?.referenceUid).toEqual(expect.any(String));
    expect(await seatCount()).toBe(1);
    await addSeat({ seatsPerTimeSlot: 0 });
    const third = await addSeat({ seatsPerTimeSlot: 0 });
    expect(third?.referenceUid).toEqual(expect.any(String));
    expect(await seatCount()).toBe(3);
  });

  it("reports missing UID before checking capacity or the numeric relation", async () => {
    await expect(
      addSeat({ bookingUid: "absent", bookingId: 999, seatsPerTimeSlot: 1 })
    ).rejects.toMatchObject({ statusCode: 404, message: "Booking not found" });
    expect(await seatCount()).toBe(0);
  });

  it("counts attendees having seats rather than unseated attendees or the seat's bookingId", async () => {
    await db
      .prepare(`INSERT INTO "Attendee" ("email", "name", "timeZone", "bookingId")
      VALUES ('unseated@example.invalid', 'Unseated', 'UTC', 1)`)
      .run();
    await db
      .prepare(`INSERT INTO "Booking" ("id", "uid", "title", "startTime", "endTime")
      VALUES (2, 'other-slot', 'Other', ?, ?)`)
      .bind(originalDate, originalDate)
      .run();
    const seat = await addSeat({ bookingId: 2, seatsPerTimeSlot: 1 });
    expect(seat?.bookingId).toBe(2);
    expect(
      await db
        .prepare('SELECT "bookingId" FROM "Attendee" WHERE "id" = ?')
        .bind(seat?.attendeeId)
        .first("bookingId")
    ).toBe(1);
    await expect(addSeat({ seatsPerTimeSlot: 1 })).rejects.toThrow(ErrorCode.BookingSeatsFull);
    expect(await seatCount()).toBe(1);
  });

  it("revives only on caller CANCELLED, preserving seat JSON, attendee defaults and UTC date storage", async () => {
    await db.prepare('UPDATE "Booking" SET "status" = ?').bind("cancelled").run();
    await addSeat();
    expect(await db.prepare('SELECT "status" FROM "Booking"').first("status")).toBe("cancelled");
    const seat = await addSeat({
      bookingStatus: BookingStatus.CANCELLED,
      seatData: { description: "", responses: null },
      metadata: { synthetic: "yes" },
    });
    expect(seat).toMatchObject({
      id: expect.any(Number),
      referenceUid: expect.any(String),
      bookingId: 1,
      attendeeId: expect.any(Number),
      data: { description: "", responses: null },
      metadata: { synthetic: "yes" },
    });
    expect(await db.prepare('SELECT "status" FROM "Booking"').first("status")).toBe("accepted");
    expect(await db.prepare('SELECT "updatedAt" FROM "Booking"').first("updatedAt")).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/
    );
    expect(
      await db
        .prepare('SELECT "phoneNumber", "locale", "noShow" FROM "Attendee" WHERE "id" = ?')
        .bind(seat?.attendeeId)
        .first()
    ).toEqual({ phoneNumber: null, locale: "en", noShow: 0 });
  });

  it("keeps omitted seat fields absent and metadata SQL null", async () => {
    const seat = await addSeat();
    expect(seat?.data).toEqual({});
    expect(seat?.metadata).toBeNull();
    expect(await db.prepare('SELECT "updatedAt" FROM "Booking"').first("updatedAt")).toBe(originalDate);
  });

  it("preserves P2002 on seat reference collision and rolls back the new attendee", async () => {
    const seat = await addSeat();
    expect(seat).not.toBeNull();
    if (!seat) throw new Error("Expected first seat");
    await expect(
      withD1Database({ DB: db }, () => addD1BookingSeat(input, seat.referenceUid))
    ).rejects.toMatchObject({ code: "P2002", meta: { target: ["referenceUid"] } });
    expect(await db.prepare('SELECT COUNT(*) FROM "Attendee"').first("COUNT(*)")).toBe(1);
  });

  it("maps missing nested Booking connect to P2025 and rolls back attendee, status and date", async () => {
    const error = await addSeat({ bookingId: 999, bookingStatus: BookingStatus.CANCELLED }).catch(
      (error: unknown) => error
    );
    expect(error).toMatchObject({ code: "P2025" });
    expect(getServerErrorFromUnknown(error).statusCode).toBe(404);
    expect(await db.prepare('SELECT COUNT(*) FROM "Attendee"').first("COUNT(*)")).toBe(0);
    expect(await db.prepare('SELECT "status", "updatedAt" FROM "Booking"').first()).toEqual({
      status: "accepted",
      updatedAt: originalDate,
    });
  });

  it("rolls back status revival and attendee when the later seat insert fails", async () => {
    await db.prepare('UPDATE "Booking" SET "status" = ?').bind("cancelled").run();
    await db
      .prepare(`CREATE TRIGGER "fail_seat_insert" BEFORE INSERT ON "BookingSeat"
      BEGIN SELECT RAISE(ABORT, 'synthetic late seat failure'); END`)
      .run();
    await expect(addSeat({ bookingStatus: BookingStatus.CANCELLED })).rejects.toThrow(
      "synthetic late seat failure"
    );
    expect(await db.prepare('SELECT COUNT(*) FROM "Attendee"').first("COUNT(*)")).toBe(0);
    expect(await db.prepare('SELECT COUNT(*) FROM "BookingSeat"').first("COUNT(*)")).toBe(0);
    expect(await db.prepare('SELECT "status", "updatedAt" FROM "Booking"').first()).toEqual({
      status: "cancelled",
      updatedAt: originalDate,
    });
  });
  it("keeps unrelated foreign-key failure as P2003 with rollback", async () => {
    await db
      .prepare(`CREATE TRIGGER "fail_seat_insert" BEFORE INSERT ON "BookingSeat" BEGIN
      INSERT INTO "Attendee" ("email", "name", "timeZone", "bookingId")
      VALUES ('failure@example.invalid', 'Failure', 'UTC', 999); END`)
      .run();
    const error = await addSeat().catch((error: unknown) => error);
    expect(error).toMatchObject({ code: "P2003" });
    expect(getServerErrorFromUnknown(error).statusCode).toBe(400);
    expect(await db.prepare('SELECT COUNT(*) FROM "Attendee"').first("COUNT(*)")).toBe(0);
  });
});
