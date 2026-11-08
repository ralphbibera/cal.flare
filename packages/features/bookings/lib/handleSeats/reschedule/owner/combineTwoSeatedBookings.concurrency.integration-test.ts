import type EventManager from "@calcom/features/bookings/lib/EventManager";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect, vi } from "vitest";
import combineTwoSeatedBookings from "./combineTwoSeatedBookings";

vi.mock("@calcom/emails/email-manager", () => ({ sendRescheduledEmailsAndSMS: vi.fn() }));

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../../apps/web/cloudflare.config")).default.worker,
  setupTimeout: 60_000,
});

type Args = Parameters<typeof combineTwoSeatedBookings>;

const OLD = 1;
const NEW = 2;
const SHARED = [11, 12, 13];
const MOVED_WITH_SEAT = 101;
const MOVED_WITHOUT_SEAT = 102;
const time = "2099-01-01T00:00:00.000+00:00";
const email = (id: number) => `shared${id}@x.invalid`;

describe("combining the same two seated bookings twice", () => {
  const combine = () => {
    const seatedBooking = {
      id: OLD,
      attendees: [
        ...SHARED.map((id) => ({ id, email: email(id), bookingSeat: null })),
        { id: MOVED_WITH_SEAT, email: "seated@x.invalid", bookingSeat: { id: 1 } },
        { id: MOVED_WITHOUT_SEAT, email: "unseated@x.invalid", bookingSeat: null },
      ],
    } as unknown as Args[1];
    const newTimeSlotBooking = {
      id: NEW,
      attendees: SHARED.map((id) => ({ email: email(id), bookingSeat: { id: 1000 + id } })),
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
    return combineTwoSeatedBookings(reschedule, seatedBooking, newTimeSlotBooking, eventManager, logger);
  };

  const ids = async (sql: string) =>
    (await d1.db.prepare(sql).all<{ id: number }>()).results.map(({ id }) => id);

  d1.beforeEach(async () => {
    const attendeeValues = [
      ...SHARED.map((id) => [id, email(id), OLD]),
      ...SHARED.map((id) => [id + 100, email(id), NEW]),
      [MOVED_WITH_SEAT, "seated@x.invalid", OLD],
      [MOVED_WITHOUT_SEAT, "unseated@x.invalid", OLD],
    ];
    const attendees = attendeeValues.map(() => `(?, ?, 'Guest', 'UTC', ?)`).join(", ");
    await d1.db.batch([
      d1.db.prepare(`DELETE FROM "BookingSeat"`),
      d1.db.prepare(`DELETE FROM "Attendee"`),
      d1.db.prepare(`DELETE FROM "Booking"`),
      d1.db
        .prepare(
          `INSERT INTO "Booking" ("id", "uid", "title", "status", "startTime", "endTime")
           VALUES (?, 'old', 'Seated', 'accepted', ?, ?), (?, 'new', 'Seated', 'accepted', ?, ?)`
        )
        .bind(OLD, time, time, NEW, time, time),
      d1.db
        .prepare(
          `INSERT INTO "Attendee" ("id", "email", "name", "timeZone", "bookingId") VALUES ${attendees}`
        )
        .bind(...attendeeValues.flat()),
      d1.db
        .prepare(
          `INSERT INTO "BookingSeat" ("id", "referenceUid", "bookingId", "attendeeId")
           VALUES (1, 'existing-seat', ?, ?)`
        )
        .bind(OLD, MOVED_WITH_SEAT),
      ...SHARED.map((id) =>
        d1.db
          .prepare(
            `INSERT INTO "BookingSeat" ("id", "referenceUid", "bookingId", "attendeeId")
             VALUES (?, ?, ?, ?)`
          )
          .bind(1000 + id, `shared-seat-${id}`, NEW, id + 100)
      ),
    ]);
  });

  d1.it(
    "converges on one seat per attendee when two combines overlap",
    async () => {
      const results = await Promise.allSettled([combine(), combine()]);

      // The original array transaction also let both reschedules run to completion, so this asserts
      // convergence of the moved rows rather than a single winner.
      expect(results.map(({ status }) => status)).toEqual(["fulfilled", "fulfilled"]);
      expect(await ids(`SELECT "id" FROM "Attendee" WHERE "bookingId" = ${OLD}`)).toEqual([]);
      expect(await ids(`SELECT "id" FROM "Attendee" WHERE "bookingId" = ${NEW} ORDER BY "id"`)).toEqual(
        [...SHARED.map((id) => id + 100), MOVED_WITH_SEAT, MOVED_WITHOUT_SEAT].sort((a, b) => a - b)
      );
      expect(
        await d1.db
          .prepare(`SELECT COUNT(*) AS "count" FROM "Attendee" WHERE "bookingId" = ?`)
          .bind(NEW)
          .first<number>("count")
      ).toBe(SHARED.length + 2);
      const seats = await d1.db
        .prepare(`SELECT "attendeeId", "bookingId" FROM "BookingSeat" ORDER BY "attendeeId"`)
        .all<{ attendeeId: number; bookingId: number }>();
      expect(seats.results).toEqual(
        [...SHARED.map((id) => id + 100), MOVED_WITH_SEAT, MOVED_WITHOUT_SEAT]
          .sort((a, b) => a - b)
          .map((attendeeId) => ({ attendeeId, bookingId: NEW }))
      );
      expect(
        await d1.db.prepare(`SELECT "status" FROM "Booking" WHERE "id" = ?`).bind(OLD).first("status")
      ).toBe("cancelled");
      expect(
        await d1.db.prepare(`SELECT "status" FROM "Booking" WHERE "id" = ?`).bind(NEW).first("status")
      ).toBe("accepted");
    },
    30_000
  );
});
