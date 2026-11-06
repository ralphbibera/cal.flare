import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { listWithTeamHandler } from "./listWithTeam.handler";

describe("listWithTeam on D1", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-list-with-team-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../../apps/web/cloudflare.config")).default;
    runtime = new Miniflare({
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
    db = await runtime.getD1Database("DB");
    await db.batch([
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email", "username") VALUES (1, 'alice', 'alice@example.invalid', 'alice'), (2, 'bob', 'bob@example.invalid', 'bob')`
      ),
      db.prepare(
        `INSERT INTO "Team" ("id", "name", "slug") VALUES (1, 'Accepted', 'accepted'), (2, 'Pending', 'pending'), (3, 'Foreign', 'foreign')`
      ),
      db.prepare(
        `INSERT INTO "Membership" ("id", "teamId", "userId", "accepted", "role") VALUES (1, 1, 1, 1, 'MEMBER'), (2, 2, 1, 0, 'MEMBER'), (3, 3, 2, 1, 'OWNER')`
      ),
      ...[
        [1, "Personal", 1, null],
        [2, "Team event", null, 1],
        [3, "Pending team event", null, 2],
        [4, "Bob personal", 2, null],
        [5, "Owned in foreign team", 1, 3],
        [6, "Owned in accepted team", 1, 1],
      ].map(([id, title, userId, teamId]) =>
        db
          .prepare(
            'INSERT INTO "EventType" ("id", "title", "slug", "length", "userId", "teamId") VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind(id, title, `event-${id}`, 15 * Number(id), userId, teamId)
      ),
    ]);
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("lists owned event types and those of accepted teams once each", async () => {
    const eventTypes = await withD1Database({ DB: db }, () =>
      listWithTeamHandler({ ctx: { user: { id: 1 } } })
    );

    expect([...eventTypes].sort((a, b) => a.id - b.id)).toEqual([
      { id: 1, team: null, title: "Personal", slug: "event-1", length: 15, username: "alice" },
      {
        id: 2,
        team: { id: 1, name: "Accepted" },
        title: "Team event",
        slug: "event-2",
        length: 30,
        username: null,
      },
      {
        id: 5,
        team: { id: 3, name: "Foreign" },
        title: "Owned in foreign team",
        slug: "event-5",
        length: 75,
        username: null,
      },
      {
        id: 6,
        team: { id: 1, name: "Accepted" },
        title: "Owned in accepted team",
        slug: "event-6",
        length: 90,
        username: null,
      },
    ]);
  });
});
