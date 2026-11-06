import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { bulkUpdateEventsToDefaultLocation } from "./bulkUpdateEventsToDefaultLocation";
import { bulkUpdateTeamEventsToDefaultLocation } from "./bulkUpdateTeamEventsToDefaultLocation";

vi.mock("../utils", () => ({
  getAppFromSlug: () => ({ slug: "zoom", appData: { location: { type: "integrations:zoom" } } }),
}));

const EVENT_TYPES = 250;
const defaultConferencingApp = { appSlug: "zoom", appLink: "https://zoom.us/my" };
const location = JSON.stringify([{ type: "integrations:zoom", link: defaultConferencingApp.appLink }]);

describe("bulk default-location updates past D1's bind limit", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const idsFrom = (first: number) => Array.from({ length: EVENT_TYPES }, (_, index) => first + index);
  const updatedIds = async () =>
    (
      await db
        .prepare(`SELECT "id" FROM "EventType" WHERE "locations" = ? ORDER BY "id"`)
        .bind(location)
        .all<{ id: number }>()
    ).results.map(({ id }) => id);
  const insertEventTypes = (first: number, owner: "userId" | "teamId", ownerId: number) =>
    db
      .prepare(
        `WITH RECURSIVE n(i) AS (SELECT 0 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
         INSERT INTO "EventType" ("id", "title", "slug", "length", "${owner}") SELECT ? + i, 'e', 'e-' || (? + i), 30, ? FROM n`
      )
      .bind(EVENT_TYPES, first, first, ownerId)
      .run();
  const failOnUpdateOf = (id: number) =>
    db
      .prepare(`CREATE TRIGGER "fail_event_type" BEFORE UPDATE ON "EventType" WHEN OLD."id" = ${id}
        BEGIN SELECT RAISE(ABORT, 'forced failure'); END`)
      .run();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-bulk-location-"));
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
      db.prepare(`INSERT INTO "users" ("id", "uuid", "email") VALUES (1, 'owner', 'owner@x.invalid'),
        (2, 'other', 'other@x.invalid')`),
      db
        .prepare(`INSERT INTO "Team" ("id", "name", "slug", "metadata") VALUES (1, 'Team', 'team', ?)`)
        .bind(JSON.stringify({ defaultConferencingApp })),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length", "userId") VALUES (9999, 'o', 'o', 30, 2)`
      ),
    ]);
    await insertEventTypes(1, "userId", 1);
    await insertEventTypes(1001, "userId", 1);
    await insertEventTypes(2001, "teamId", 1);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const user = { id: 1, metadata: { defaultConferencingApp } };

  it("leaves every user event type unchanged when one update fails", async () => {
    await failOnUpdateOf(1200);
    await expect(
      inD1(() => bulkUpdateEventsToDefaultLocation({ eventTypeIds: idsFrom(1001), user, prisma }))
    ).rejects.toThrow("forced failure");
    await db.prepare(`DROP TRIGGER "fail_event_type"`).run();
    expect(await updatedIds()).toEqual([]);
  });

  it("updates only the user's own event types and reports the count", async () => {
    await expect(
      inD1(() => bulkUpdateEventsToDefaultLocation({ eventTypeIds: [...idsFrom(1), 9999], user, prisma }))
    ).resolves.toEqual({ count: EVENT_TYPES });
    expect(await updatedIds()).toEqual(idsFrom(1));
  });

  it("leaves every team event type unchanged when one update fails", async () => {
    await failOnUpdateOf(2200);
    await expect(
      inD1(() => bulkUpdateTeamEventsToDefaultLocation({ eventTypeIds: idsFrom(2001), teamId: 1, prisma }))
    ).rejects.toThrow("forced failure");
    await db.prepare(`DROP TRIGGER "fail_event_type"`).run();
    expect(await updatedIds()).toEqual(idsFrom(1));
  });

  it("updates only the team's event types and reports the count", async () => {
    await expect(
      inD1(() =>
        bulkUpdateTeamEventsToDefaultLocation({ eventTypeIds: [...idsFrom(2001), 9999], teamId: 1, prisma })
      )
    ).resolves.toEqual({ count: EVENT_TYPES });
    expect(await updatedIds()).toEqual([...idsFrom(1), ...idsFrom(2001)]);
  });
});
