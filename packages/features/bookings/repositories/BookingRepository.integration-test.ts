import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BookingRepository } from "./BookingRepository";

describe("BookingRepository total booking duration on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-booking-duration-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
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
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length") VALUES (1, 'Limited', 'limited', 30), (2, 'Other', 'other', 30)`
      ),
      ...[
        ["window-start", 1, "accepted", "2026-11-01T00:00:00.000", "2026-11-01T00:30:00.000"],
        ["half-minute", 1, "accepted", "2026-11-10T10:00:00.000", "2026-11-10T10:45:30.000"],
        ["window-end", 1, "accepted", "2026-11-30T23:00:00.000", "2026-12-01T00:00:00.000"],
        ["milliseconds", 1, "accepted", "2026-11-20T12:00:00.000", "2026-11-20T12:10:00.600"],
        ["cancelled", 1, "cancelled", "2026-11-05T09:00:00.000", "2026-11-05T10:40:00.000"],
        ["pending", 1, "pending", "2026-11-06T09:00:00.000", "2026-11-06T10:40:00.000"],
        ["other-event", 2, "accepted", "2026-11-07T09:00:00.000", "2026-11-07T12:20:00.000"],
        ["starts-before", 1, "accepted", "2026-10-31T23:30:00.000", "2026-11-01T00:30:00.000"],
        ["ends-after", 1, "accepted", "2026-11-30T23:30:00.000", "2026-12-01T00:30:00.000"],
      ].map(([uid, eventTypeId, status, startTime, endTime]) =>
        db
          .prepare(
            'INSERT INTO "Booking" ("uid", "title", "eventTypeId", "status", "startTime", "endTime") VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind(uid, uid, eventTypeId, status, `${startTime}+00:00`, `${endTime}+00:00`)
      ),
    ]);
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const repository = new BookingRepository(prisma);
  const window = {
    eventId: 1,
    startDate: new Date("2026-11-01T00:00:00.000Z"),
    endDate: new Date("2026-12-01T00:00:00.000Z"),
  };
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  it("sums fractional minutes of accepted bookings for the event inside the inclusive window", async () => {
    await expect(inD1(() => repository.getTotalBookingDuration(window))).resolves.toBe(145.51);
  });

  it("excludes the booking being rescheduled", async () => {
    await expect(
      inD1(() => repository.getTotalBookingDuration({ ...window, rescheduleUid: "half-minute" }))
    ).resolves.toBe(100.01);
  });

  it("returns zero when no booking matches", async () => {
    const unknownEvent = { ...window, eventId: 999 };
    await expect(inD1(() => repository.getTotalBookingDuration(unknownEvent))).resolves.toBe(0);
  });
});
