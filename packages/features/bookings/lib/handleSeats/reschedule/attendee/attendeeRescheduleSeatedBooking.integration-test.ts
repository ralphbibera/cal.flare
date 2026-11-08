import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendRescheduledSeatEmailAndSMS } from "@calcom/emails/email-manager";
import type EventManager from "@calcom/features/bookings/lib/EventManager";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import attendeeRescheduleSeatedBooking from "./attendeeRescheduleSeatedBooking";

vi.mock("@calcom/emails/email-manager", () => ({ sendRescheduledSeatEmailAndSMS: vi.fn() }));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: vi.fn() }));
vi.mock("@calcom/features/bookings/lib/handleSeats/lib/lastAttendeeDeleteBooking", () => ({
  default: vi.fn().mockResolvedValue(false),
}));

type Args = Parameters<typeof attendeeRescheduleSeatedBooking>;

const OLD = 1;
const NEW = 2;
const OTHER = 3;
const ATTENDEE = 10;
const SEAT = 100;
const time = "2099-01-01T00:00:00.000+00:00";

describe("moving a seated attendee on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  const rows = async () => {
    const attendee = await db
      .prepare(`SELECT "bookingId" FROM "Attendee" WHERE "id" = ?`)
      .bind(ATTENDEE)
      .first<{ bookingId: number | null }>();
    const seat = await db
      .prepare(`SELECT "bookingId" FROM "BookingSeat" WHERE "id" = ?`)
      .bind(SEAT)
      .first<{ bookingId: number }>();
    const seatCount = await db
      .prepare(`SELECT COUNT(*) AS "count" FROM "BookingSeat" WHERE "attendeeId" = ?`)
      .bind(ATTENDEE)
      .first<{ count: number }>();
    return {
      attendeeBooking: attendee?.bookingId,
      seatBooking: seat?.bookingId,
      seatCount: seatCount?.count,
    };
  };

  const move = (
    bookingId: number,
    eventManager = createEventManager(),
    attendeeId = ATTENDEE,
    seatId = SEAT
  ) => {
    const seatAttendee = {
      id: attendeeId,
      email: "seat@example.invalid",
      name: "Seat",
      timeZone: "UTC",
      locale: "en",
    };
    const bookingSeat = {
      id: seatId,
      referenceUid: "seat-reference",
      bookingId: OLD,
      attendeeId,
      attendee: seatAttendee,
      data: null,
      metadata: null,
    };
    const evt = {
      attendees: [],
      startTime: time,
      endTime: time,
      type: "seated",
      title: "Seated",
      organizer: { name: "Host", email: "host@example.invalid", timeZone: "UTC" },
      bookerUrl: "https://example.invalid",
    };
    const reschedule = {
      tAttendees: (key: string) => key,
      bookingSeat,
      bookerEmail: seatAttendee.email,
      evt,
      eventType: { metadata: {} },
      originalRescheduledBooking: null,
    };
    const newTimeSlotBooking = {
      id: bookingId,
      uid: `booking-${bookingId}`,
      iCalUID: "ical-new",
      attendees: [],
      references: [],
    };
    return withD1Database({ DB: db }, () =>
      attendeeRescheduleSeatedBooking(
        reschedule as unknown as Args[0],
        seatAttendee as unknown as Args[1],
        newTimeSlotBooking as unknown as Args[2],
        evt as unknown as Args[3],
        eventManager as unknown as Args[4]
      )
    );
  };

  function createEventManager() {
    return { updateCalendarAttendees: vi.fn().mockResolvedValue(undefined) } as unknown as EventManager;
  }

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-attendee-seat-"));
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
    vi.clearAllMocks();
    await db.batch([
      db.prepare(`DROP TRIGGER IF EXISTS "fail_seat_move"`),
      db.prepare(`DELETE FROM "BookingSeat"`),
      db.prepare(`DELETE FROM "Attendee"`),
      db.prepare(`DELETE FROM "Booking"`),
      db
        .prepare(
          `INSERT INTO "Booking" ("id", "uid", "title", "status", "startTime", "endTime")
           VALUES (?, 'old', 'Seated', 'accepted', ?, ?), (?, 'new', 'Seated', 'accepted', ?, ?),
             (?, 'other', 'Seated', 'accepted', ?, ?)`
        )
        .bind(OLD, time, time, NEW, time, time, OTHER, time, time),
      db
        .prepare(`INSERT INTO "Attendee" ("id", "email", "name", "timeZone", "bookingId")
          VALUES (?, 'seat@example.invalid', 'Seat', 'UTC', ?)`)
        .bind(ATTENDEE, OLD),
      db
        .prepare(`INSERT INTO "BookingSeat" ("id", "referenceUid", "bookingId", "attendeeId")
          VALUES (?, 'seat-reference', ?, ?)`)
        .bind(SEAT, OLD, ATTENDEE),
    ]);
  });

  it("moves the attendee and its seat to the new booking together", async () => {
    const eventManager = createEventManager();

    const result = await move(NEW, eventManager);

    expect(await rows()).toEqual({ attendeeBooking: NEW, seatBooking: NEW, seatCount: 1 });
    expect(result).toMatchObject({ uid: "new", seatReferenceUid: "seat-reference" });
    expect(eventManager.updateCalendarAttendees).toHaveBeenCalledWith(
      expect.objectContaining({ iCalUID: "ical-new", attendeeSeatId: "seat-reference" }),
      expect.objectContaining({ id: NEW })
    );
    expect(sendRescheduledSeatEmailAndSMS).toHaveBeenCalledTimes(1);
  });

  it("rolls back the attendee move when the seat update fails", async () => {
    await db
      .prepare(`CREATE TRIGGER "fail_seat_move" BEFORE UPDATE ON "BookingSeat" WHEN OLD."id" = ${SEAT}
        BEGIN SELECT RAISE(ABORT, 'forced seat failure'); END`)
      .run();
    const eventManager = createEventManager();

    await expect(move(NEW, eventManager)).rejects.toThrow("forced seat failure");

    expect(await rows()).toEqual({ attendeeBooking: OLD, seatBooking: OLD, seatCount: 1 });
    expect(eventManager.updateCalendarAttendees).not.toHaveBeenCalled();
    expect(sendRescheduledSeatEmailAndSMS).not.toHaveBeenCalled();
  });

  it("keeps both rows unchanged when the attendee no longer exists", async () => {
    const error = await move(NEW, createEventManager(), 999, SEAT).catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "P2025", meta: { modelName: "Attendee" } });
    expect(await rows()).toEqual({ attendeeBooking: OLD, seatBooking: OLD, seatCount: 1 });
  });

  it("keeps both rows unchanged when the seat no longer exists", async () => {
    await db.prepare(`DELETE FROM "BookingSeat" WHERE "id" = ?`).bind(SEAT).run();

    const error = await move(NEW).catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "P2025", meta: { modelName: "BookingSeat" } });
    expect(await rows()).toEqual({ attendeeBooking: OLD, seatBooking: undefined, seatCount: 0 });
  });

  it("maps a missing target booking to P2003 and keeps both rows in the old booking", async () => {
    await db.prepare(`DELETE FROM "Booking" WHERE "id" = ?`).bind(NEW).run();

    const error = await move(NEW).catch((error: unknown) => error);

    expect(error).toMatchObject({ code: "P2003" });
    expect(await rows()).toEqual({ attendeeBooking: OLD, seatBooking: OLD, seatCount: 1 });
  });

  it("keeps the attendee and seat together when two conflicting moves overlap", async () => {
    const results = await Promise.allSettled([move(NEW), move(OTHER)]);

    expect(results.every((result) => result.status === "fulfilled")).toBe(true);
    const state = await rows();
    expect(state.seatCount).toBe(1);
    expect(state.attendeeBooking).toBe(state.seatBooking);
    expect([NEW, OTHER]).toContain(state.attendeeBooking);
  });
});
