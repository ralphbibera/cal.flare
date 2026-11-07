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

const TEAM_COUNT = 250;

describe("listTeamAvailability across a long team list on D1", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ids = Array.from({ length: TEAM_COUNT }, (_, index) => index + 1);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-team-availability-large-"));
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
      ...ids.map((id) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (?, ?, ?)')
          .bind(id, `availability-${id}`, `availability-${id}@example.invalid`)
      ),
      ...ids.map((id) =>
        db.prepare('INSERT INTO "Team" ("id", "name") VALUES (?, ?)').bind(id, `Team ${id}`)
      ),
      ...ids.map((id) =>
        db
          .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, 1, 1, ?)')
          .bind(id, "MEMBER")
      ),
      ...ids
        .slice(1)
        .map((id) =>
          db
            .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, ?, 1, ?)')
            .bind(id, id, "MEMBER")
        ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("pages every distinct member of the user's teams and counts them once", async () => {
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

    expect(result.meta.totalRowCount).toBe(TEAM_COUNT);
    expect(result.rows.map(({ id }) => id)).toEqual(ids.slice(0, 10));
    expect(result.nextCursor).toBeDefined();
  });
});
