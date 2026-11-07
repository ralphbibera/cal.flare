import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { TrpcSessionUser } from "../../../../types";
import { listTeamAvailabilityHandler } from "./listTeamAvailability.handler";

describe("listTeamAvailability across all teams on D1", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-team-availability-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../../../apps/web/cloudflare.config")).default;
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
      ...[1, 2, 3, 4, 5].map((id) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email", "username") VALUES (?, ?, ?, ?)')
          .bind(id, `member-${id}`, `member${id}@example.invalid`, `member${id}`)
      ),
      db.prepare(`INSERT INTO "Team" ("id", "name", "slug") VALUES (1, 'One', 'one'), (2, 'Two', 'two')`),
      ...[
        [1, 1, 1],
        [1, 2, 1],
        [1, 3, 1],
        [2, 1, 1],
        [2, 3, 1],
        [2, 4, 1],
        [2, 5, 0],
      ].map(([teamId, userId, accepted]) =>
        db
          .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, ?, ?, ?)')
          .bind(teamId, userId, accepted, "MEMBER")
      ),
    ]);
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("counts each distinct member of the user's teams once as a number", async () => {
    const user = mockDeep<NonNullable<TrpcSessionUser>>();
    user.id = 1;
    user.organizationId = null;

    const result = await withD1Database({ DB: db }, () =>
      listTeamAvailabilityHandler({
        ctx: { user },
        input: {
          limit: 10,
          startDate: "2026-11-05T00:00:00.000Z",
          endDate: "2026-11-06T00:00:00.000Z",
          loggedInUsersTz: "UTC",
        },
      })
    );

    expect(result.meta.totalRowCount).toBe(5);
    expect(result.rows.map(({ id }) => id)).toEqual([1, 2, 3, 4, 5]);
  });
});
