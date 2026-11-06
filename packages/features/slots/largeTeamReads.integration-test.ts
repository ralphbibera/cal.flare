import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookingRepository } from "@calcom/features/bookings/repositories/BookingRepository";
import { PrismaOOORepository } from "@calcom/features/ooo/repositories/PrismaOOORepository";
import { PrismaSelectedSlotRepository } from "@calcom/features/selectedSlots/repositories/PrismaSelectedSlotRepository";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOSTS = 250;
const hostIds = Array.from({ length: HOSTS }, (_, index) => index + 1);
const email = (id: number) => `host${id}@team.invalid`;
const at = (hour: number) => `2026-11-05T${String(hour).padStart(2, "0")}:00:00.000+00:00`;

describe("slot reads for a team past D1's bind limit", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-large-team-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../apps/web/cloudflare.config")).default;
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
    await db.batch([
      db.prepare(`INSERT INTO "EventType" ("id", "title", "slug", "length") VALUES (1, 'Team', 'team', 30)`),
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES (1000, 'outsider', 'outsider@x.invalid')`
      ),
    ]);
    const booking = (id: number, userId: number | null, status = "accepted", hour = 10) =>
      db
        .prepare(
          `INSERT INTO "Booking" ("id", "uid", "title", "description", "startTime", "endTime", "updatedAt", "userId", "eventTypeId", "status")
           VALUES (?, ?, 'b', '', ?, ?, ?, ?, 1, ?)`
        )
        .bind(id, `booking-${id}`, at(hour), at(hour + 1), at(0), userId, status);
    const attendee = (bookingId: number, address: string) =>
      db
        .prepare(
          `INSERT INTO "Attendee" ("email", "name", "timeZone", "bookingId") VALUES (?, 'a', 'UTC', ?)`
        )
        .bind(address, bookingId);
    for (let index = 0; index < HOSTS; index += 25) {
      await db.batch(
        hostIds.slice(index, index + 25).flatMap((id) => [
          db
            .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (?, ?, ?)')
            .bind(id, `host-${id}`, email(id)),
          booking(id, id),
          attendee(id, "guest@x.invalid"),
          db
            .prepare(
              `INSERT INTO "OutOfOfficeEntry" ("uuid", "start", "end", "userId", "updatedAt") VALUES (?, ?, ?, ?, ?)`
            )
            .bind(`ooo-${id}`, at(8), at(12), id, at(0)),
          db
            .prepare(
              `INSERT INTO "SelectedSlots" ("eventTypeId", "userId", "slotUtcStartDate", "slotUtcEndDate", "uid", "releaseAt")
               VALUES (1, ?, ?, ?, ?, ?)`
            )
            .bind(id, at(10), at(11), `slot-${id}`, "2099-01-01T00:00:00Z"),
        ])
      );
    }
    await db.batch([
      // An outside organizer's booking with hosts from different chunks as attendees.
      booking(5000, 1000),
      attendee(5000, email(1)),
      attendee(5000, email(HOSTS)),
      // A host attending their own booking is reported once, through the organizer match.
      attendee(7, email(7)),
      booking(5001, 1, "cancelled"),
      booking(5002, 2, "accepted", 20),
      db
        .prepare(
          `INSERT INTO "OutOfOfficeEntry" ("uuid", "start", "end", "userId", "updatedAt") VALUES ('late', ?, ?, 3, ?)`
        )
        .bind(at(20), at(21), at(0)),
      db
        .prepare(
          `INSERT INTO "SelectedSlots" ("eventTypeId", "userId", "slotUtcStartDate", "slotUtcEndDate", "uid", "releaseAt")
           VALUES (1, 4, ?, ?, 'expired', '2000-01-01T00:00:00Z')`
        )
        .bind(at(10), at(11)),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const sorted = (values: number[]) => values.toSorted((a, b) => a - b);

  it("finds every host's bookings and attendee bookings once", async () => {
    const bookings = await inD1(() =>
      new BookingRepository(prisma).findAllExistingBookingsForEventTypeBetween({
        startDate: new Date(at(9)),
        endDate: new Date(at(12)),
        eventTypeId: 1,
        userIdAndEmailMap: new Map(hostIds.map((id) => [id, email(id)])),
      })
    );
    expect(sorted(bookings.map((row) => row.id))).toEqual([...hostIds, 5000]);
    expect(bookings.find((row) => row.id === 5000)?.attendees).toHaveLength(2);
  });

  it("finds out-of-office entries for every host", async () => {
    const repository = new PrismaOOORepository(prisma);
    const range = { startTimeDate: new Date(at(9)), endTimeDate: new Date(at(12)) };
    const entries = await inD1(() =>
      repository.findManyOOO({ ...range, allUserIds: [...hostIds, ...hostIds] })
    );
    expect(sorted(entries.map((entry) => entry.user.id))).toEqual(hostIds);

    const interval = await inD1(() =>
      repository.findOOOEntriesInInterval({
        userIds: hostIds,
        startDate: range.startTimeDate,
        endDate: range.endTimeDate,
      })
    );
    expect(sorted(interval.map((entry) => entry.userId))).toEqual(hostIds);
  });

  it("finds every host's unexpired reserved slots", async () => {
    const slots = await inD1(() =>
      new PrismaSelectedSlotRepository(prisma).findManyUnexpiredSlots({
        userIds: hostIds,
        currentTimeInUtc: "2026-11-05T00:00:00Z",
      })
    );
    expect(sorted(slots.map((slot) => slot.userId))).toEqual(hostIds);
  });
});
