import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type EventManager from "@calcom/features/bookings/lib/EventManager";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import combineTwoSeatedBookings from "./combineTwoSeatedBookings";

vi.mock("@calcom/emails/email-manager", () => ({ sendRescheduledEmailsAndSMS: vi.fn() }));

type Args = Parameters<typeof combineTwoSeatedBookings>;

const SHARED = 250;
const OLD = 1;
const NEW = 2;
const shared = Array.from({ length: SHARED }, (_, index) => index + 1);
const MOVED_WITH_SEAT = 1001;
const MOVED_WITHOUT_SEAT = 1002;
const time = "2099-01-01T00:00:00.000+00:00";

describe("combining seated bookings that share attendees past D1's bind limit", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ids = async (sql: string) =>
    (await db.prepare(sql).all<{ id: number }>()).results.map(({ id }) => id);

  const combine = () => {
    const seatedBooking = {
      id: OLD,
      attendees: [
        ...shared.map((id) => ({ id, email: `shared${id}@x.invalid`, bookingSeat: null })),
        { id: MOVED_WITH_SEAT, email: "seated@x.invalid", bookingSeat: { id: 1 } },
        { id: MOVED_WITHOUT_SEAT, email: "unseated@x.invalid", bookingSeat: null },
      ],
    } as unknown as Args[1];
    const newTimeSlotBooking = {
      id: NEW,
      attendees: shared.map((id) => ({ email: `shared${id}@x.invalid`, bookingSeat: { id: 1000 + id } })),
    } as unknown as Args[2];
    const reschedule = {
      eventType: { seatsPerTimeSlot: 1000, metadata: {} },
      evt: { type: "seated", title: "Seated", startTime: time, endTime: time, attendees: [], organizer: {} },
      tAttendees: (key: string) => key,
      rescheduleUid: "old",
      noEmail: true,
    } as unknown as Args[0];
    const eventManager = {
      reschedule: vi.fn().mockResolvedValue({ results: [] }),
    } as unknown as EventManager;
    const logger = { debug: vi.fn() } as unknown as Args[4];
    return withD1Database({ DB: db }, () =>
      combineTwoSeatedBookings(reschedule, seatedBooking, newTimeSlotBooking, eventManager, logger)
    );
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-combine-seats-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../../../apps/web/cloudflare.config")).default;
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
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    const attendees = (bookingId: number, idOffset: number) =>
      db
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ?)
           INSERT INTO "Attendee" ("id", "email", "name", "timeZone", "bookingId")
           SELECT ? + i, 'shared' || i || '@x.invalid', 'Guest', 'UTC', ? FROM n`
        )
        .bind(SHARED, idOffset, bookingId);
    await db.batch([
      db.prepare(`DROP TRIGGER IF EXISTS "fail_row"`),
      db.prepare(`DELETE FROM "Booking"`),
      db
        .prepare(`INSERT INTO "Booking" ("id", "uid", "title", "status", "startTime", "endTime")
          VALUES (?, 'old', 'Seated', 'accepted', ?, ?), (?, 'new', 'Seated', 'accepted', ?, ?)`)
        .bind(OLD, time, time, NEW, time, time),
      attendees(OLD, 0),
      attendees(NEW, 2000),
      db
        .prepare(`INSERT INTO "Attendee" ("id", "email", "name", "timeZone", "bookingId")
          VALUES (?, 'seated@x.invalid', 'Seated', 'UTC', ?), (?, 'unseated@x.invalid', 'Unseated', 'UTC', ?)`)
        .bind(MOVED_WITH_SEAT, OLD, MOVED_WITHOUT_SEAT, OLD),
      db
        .prepare(`INSERT INTO "BookingSeat" ("id", "referenceUid", "bookingId", "attendeeId")
          VALUES (1, 'existing-seat', ?, ?)`)
        .bind(OLD, MOVED_WITH_SEAT),
    ]);
  });

  it("moves the new attendees with their seats and deletes the shared ones", async () => {
    await combine();

    expect(await ids(`SELECT "id" FROM "Attendee" WHERE "bookingId" = ${OLD}`)).toEqual([]);
    expect(
      await ids(`SELECT "id" FROM "Attendee" WHERE "id" > ${SHARED} AND "id" < 2000 AND "bookingId" = ${NEW}`)
    ).toEqual([MOVED_WITH_SEAT, MOVED_WITHOUT_SEAT]);
    const seats = await db
      .prepare(`SELECT "referenceUid", "bookingId", "attendeeId" FROM "BookingSeat" ORDER BY "attendeeId"`)
      .all<{ referenceUid: string; bookingId: number; attendeeId: number }>();
    expect(seats.results).toEqual([
      { referenceUid: "existing-seat", bookingId: NEW, attendeeId: MOVED_WITH_SEAT },
      { referenceUid: expect.any(String), bookingId: NEW, attendeeId: MOVED_WITHOUT_SEAT },
    ]);
    expect(await db.prepare(`SELECT "status" FROM "Booking" WHERE "id" = ${OLD}`).first("status")).toBe(
      "cancelled"
    );
  });

  it("moves and deletes nothing when one deletion fails", async () => {
    await db
      .prepare(`CREATE TRIGGER "fail_row" BEFORE DELETE ON "Attendee" WHEN OLD."id" = 125
        BEGIN SELECT RAISE(ABORT, 'forced failure'); END`)
      .run();

    await expect(combine()).rejects.toThrow("forced failure");
    expect(await ids(`SELECT "id" FROM "Attendee" WHERE "bookingId" = ${OLD}`)).toEqual([
      ...shared,
      MOVED_WITH_SEAT,
      MOVED_WITHOUT_SEAT,
    ]);
    expect(await ids(`SELECT "attendeeId" AS "id" FROM "BookingSeat"`)).toEqual([MOVED_WITH_SEAT]);
    expect(await ids(`SELECT "id" FROM "BookingSeat" WHERE "bookingId" = ${NEW}`)).toEqual([]);
  });

  it("changes nothing when an attendee to move no longer exists", async () => {
    await db.prepare(`DELETE FROM "Attendee" WHERE "id" = ${MOVED_WITHOUT_SEAT}`).run();

    await expect(combine()).rejects.toMatchObject({ code: "P2025" });
    expect(await ids(`SELECT "id" FROM "Attendee" WHERE "bookingId" = ${OLD}`)).toEqual([
      ...shared,
      MOVED_WITH_SEAT,
    ]);
  });
});
