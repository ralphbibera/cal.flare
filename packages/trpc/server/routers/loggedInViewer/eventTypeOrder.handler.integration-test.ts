import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eventTypeOrderHandler } from "./eventTypeOrder.handler";

const EVENT_TYPES = 250;
const ids = Array.from({ length: EVENT_TYPES }, (_, index) => index + 1);
const ctx = { user: { id: 1 } } as Parameters<typeof eventTypeOrderHandler>[0]["ctx"];

describe("event type ordering past D1's bind limit", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const positions = async () =>
    (
      await db
        .prepare(`SELECT "position" FROM "EventType" WHERE "id" <= ? ORDER BY "id"`)
        .bind(EVENT_TYPES)
        .all<{ position: number }>()
    ).results.map(({ position }) => position);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-event-type-order-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../apps/web/cloudflare.config")).default;
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
      db.prepare(`INSERT INTO "Team" ("id", "name", "slug") VALUES (1, 'Team', 'team')`),
      db.prepare(
        `INSERT INTO "Membership" ("teamId", "userId", "role", "accepted") VALUES (1, 1, 'MEMBER', 1)`
      ),
      db
        .prepare(
          `WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < ? - 1)
           INSERT INTO "EventType" ("id", "title", "slug", "length", "userId") SELECT i, 'e', 'e-' || i, 30, 1 FROM n`
        )
        .bind(EVENT_TYPES),
      db
        .prepare(
          `INSERT INTO "EventType" ("id", "title", "slug", "length", "teamId") VALUES (?, 't', 't', 30, 1)`
        )
        .bind(EVENT_TYPES),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length", "userId") VALUES (9999, 'o', 'o', 30, 2)`
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("rejects the order without writing when one event type belongs to someone else", async () => {
    await expect(inD1(() => eventTypeOrderHandler({ ctx, input: { ids: [...ids, 9999] } }))).rejects.toThrow(
      expect.objectContaining({ code: "UNAUTHORIZED" })
    );
    expect(new Set(await positions())).toEqual(new Set([0]));
  });

  it("orders owned and team event types with the first id on top", async () => {
    await inD1(() => eventTypeOrderHandler({ ctx, input: { ids: [...ids] } }));
    expect(await positions()).toEqual(ids.map((id) => EVENT_TYPES - id));
  });
});
