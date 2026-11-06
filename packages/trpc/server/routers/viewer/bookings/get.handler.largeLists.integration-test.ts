import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import kysely from "@calcom/kysely";
import prisma from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getBookings } from "./get.handler";

const TEAM_COUNT = 250;

describe("getBookings filters over a long team list on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const teamIds = Array.from({ length: TEAM_COUNT }, (_, index) => index + 1);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-booking-team-filter-"));
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
    await db.batch([
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES (1, 'team-filter-user', 'team-filter@example.invalid')`
      ),
      ...teamIds.map((id) =>
        db.prepare('INSERT INTO "Team" ("id", "name") VALUES (?, ?)').bind(id, `Team ${id}`)
      ),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length", "teamId") VALUES (250, 'Last team', 'last-team', 30, 250)`
      ),
      db.prepare(
        `INSERT INTO "Booking" ("uid", "title", "userId", "eventTypeId", "status", "startTime", "endTime")
         VALUES ('last-team-booking', 'Last team booking', 1, 250, 'accepted', '2027-01-01T00:00:00.000+00:00', '2027-01-01T00:30:00.000+00:00')`
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("filters by an event type that belongs to the last team in the list", async () => {
    const result = await withD1Database({ DB: db }, () =>
      getBookings({
        user: { id: 1, email: "team-filter@example.invalid", orgId: null },
        prisma,
        kysely,
        bookingListingByStatus: ["upcoming"],
        filters: { teamIds },
        take: 10,
        skip: 0,
      })
    );

    expect(result.bookings.map(({ uid }) => uid)).toEqual(["last-team-booking"]);
  });
});
