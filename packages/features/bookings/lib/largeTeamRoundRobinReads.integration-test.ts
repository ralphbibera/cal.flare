import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookingRepository } from "@calcom/features/bookings/repositories/BookingRepository";
import { HostRepository } from "@calcom/features/host/repositories/HostRepository";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { RRTimestampBasis } from "@calcom/prisma/enums";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const HOSTS = 250;
const hostIds = Array.from({ length: HOSTS }, (_, index) => index + 1);
const email = (id: number) => `host${id}@team.invalid`;
const minute = (offset: number) =>
  new Date(Date.UTC(2026, 10, 5, 0, offset)).toISOString().replace("Z", "+00:00");

describe("round-robin reads for a team past D1's bind limit", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-large-rr-"));
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
    const booking = (id: number, userId: number, createdAt: string) =>
      db
        .prepare(
          `INSERT INTO "Booking" ("id", "uid", "title", "description", "startTime", "endTime", "createdAt", "userId", "eventTypeId", "status")
           VALUES (?, ?, 'b', '', ?, ?, ?, ?, 1, 'accepted')`
        )
        .bind(id, `booking-${id}`, minute(0), minute(30), createdAt, userId);
    const attendee = (bookingId: number, address: string) =>
      db
        .prepare(
          `INSERT INTO "Attendee" ("email", "name", "timeZone", "bookingId") VALUES (?, 'a', 'UTC', ?)`
        )
        .bind(address, bookingId);
    await db.batch([
      db.prepare(`INSERT INTO "EventType" ("id", "title", "slug", "length") VALUES (1, 'RR', 'rr', 30)`),
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES (1000, 'outsider', 'outsider@x.invalid')`
      ),
    ]);
    for (let index = 0; index < HOSTS; index += 25) {
      await db.batch(
        hostIds
          .slice(index, index + 25)
          .flatMap((id) => [
            db
              .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (?, ?, ?)')
              .bind(id, `host-${id}`, email(id)),
            db
              .prepare(
                `INSERT INTO "Host" ("userId", "eventTypeId", "isFixed", "createdAt") VALUES (?, 1, 0, ?)`
              )
              .bind(id, id % 2 === 0 ? minute(0) : "2026-10-01T00:00:00.000+00:00"),
            booking(id, id, minute(id)),
            attendee(id, "guest@x.invalid"),
          ])
      );
    }
    await db.batch([
      // An outside organizer's booking with hosts from different chunks as attendees.
      booking(5000, 1000, "2026-11-06T00:00:00.000+00:00"),
      attendee(5000, email(1)),
      attendee(5000, email(HOSTS)),
      booking(6000, 3, "2026-11-04T00:00:00.000+00:00"),
      attendee(6000, "guest@x.invalid"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("finds every host's interval bookings once, newest first", async () => {
    const bookings = await inD1(() =>
      new BookingRepository(prisma).getAllBookingsForRoundRobin({
        users: hostIds.map((id) => ({ id, email: email(id) })),
        eventTypeId: 1,
        startDate: new Date("2026-11-01T00:00:00Z"),
        endDate: new Date("2026-12-01T00:00:00Z"),
        includeNoShowInRRCalculation: false,
        rrTimestampBasis: RRTimestampBasis.CREATED_AT,
      })
    );
    expect(bookings.map((row) => row.id)).toEqual([5000, ...hostIds.toReversed(), 6000]);
  });

  it("finds round-robin hosts added during the interval", async () => {
    const hosts = await inD1(() =>
      new HostRepository(prisma).findHostsCreatedInInterval({
        eventTypeId: 1,
        userIds: hostIds,
        startDate: new Date("2026-10-15T00:00:00Z"),
      })
    );
    expect(hosts.map((host) => host.userId).toSorted((a, b) => a - b)).toEqual(
      hostIds.filter((id) => id % 2 === 0)
    );
  });

  it("finds each host's latest booking", async () => {
    const users = await inD1(() =>
      new UserRepository(prisma).findUsersWithLastBooking({ userIds: hostIds, eventTypeId: 1 })
    );
    expect(users.map((user) => user.id).toSorted((a, b) => a - b)).toEqual(hostIds);
    const lastCreatedAt = new Map(users.map((user) => [user.id, user.bookings.map((row) => row.createdAt)]));
    expect(lastCreatedAt.get(3)).toEqual([new Date(minute(3))]);
    expect(lastCreatedAt.get(HOSTS)).toEqual([new Date(minute(HOSTS))]);
  });
});
