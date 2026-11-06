import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prisma from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getUserIdsFromTeamIds } from "./get.handler";

const TEAM_COUNT = 250;

describe("getUserIdsFromTeamIds over a long team list on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const teamIds = Array.from({ length: TEAM_COUNT }, (_, index) => index + 1);
  const userIds = teamIds.map((id) => id + 1);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-team-users-large-lists-"));
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
      ...teamIds.map((id) =>
        db.prepare('INSERT INTO "Team" ("id", "name") VALUES (?, ?)').bind(id, `Team ${id}`)
      ),
      ...userIds.map((id) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (?, ?, ?)')
          .bind(id, `team-user-${id}`, `team-user-${id}@example.invalid`)
      ),
      ...userIds.map((id) =>
        db
          .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, ?, 1, ?)')
          .bind(id - 1, id, "MEMBER")
      ),
      // A user in two of the requested teams still appears once.
      db
        .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (2, 2, 1, ?)')
        .bind("MEMBER"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("returns every team member once for a long team list", async () => {
    const result = await withD1Database({ DB: db }, () => getUserIdsFromTeamIds(prisma, teamIds));
    expect(result.sort((left, right) => left - right)).toEqual(userIds);
  });
});
