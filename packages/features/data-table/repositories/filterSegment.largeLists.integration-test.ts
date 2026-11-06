import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FilterSegmentRepository } from "./filterSegment";

const TEAM_COUNT = 250;
const tableIdentifier = "large-table";

describe("FilterSegmentRepository over a long team list on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const teamIds = Array.from({ length: TEAM_COUNT }, (_, index) => index + 2);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-filter-segment-large-lists-"));
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
    const updatedAt = "2026-01-01T00:00:00.000+00:00";
    await db.batch([
      db
        .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (1, ?, ?)')
        .bind("segment-user", "segment@example.invalid"),
      ...teamIds.map((id) =>
        db.prepare('INSERT INTO "Team" ("id", "name") VALUES (?, ?)').bind(id, `Team ${id}`)
      ),
      ...teamIds.map((id) =>
        db
          .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, 1, 1, ?)')
          .bind(id, "MEMBER")
      ),
      db
        .prepare(
          `INSERT INTO "FilterSegment" ("name", "tableIdentifier", "scope", "perPage", "updatedAt", "userId")
           VALUES ('User segment', ?, 'USER', 10, ?, 1)`
        )
        .bind(tableIdentifier, updatedAt),
      ...teamIds.map((id, index) =>
        db
          .prepare(
            `INSERT INTO "FilterSegment" ("name", "tableIdentifier", "scope", "perPage", "createdAt", "updatedAt", "userId", "teamId")
             VALUES (?, ?, 'TEAM', 10, ?, ?, 1, ?)`
          )
          .bind(
            `Team segment ${id}`,
            tableIdentifier,
            new Date(Date.UTC(2026, 0, 1, 0, 0, index)).toISOString().replace("Z", "+00:00"),
            updatedAt,
            id
          )
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("returns user and team segments for a long team list", async () => {
    const { segments } = await inD1(() => new FilterSegmentRepository().get({ userId: 1, tableIdentifier }));
    expect(segments).toHaveLength(TEAM_COUNT + 1);
    expect(segments.map(({ scope }) => scope)[0]).toBe("USER");
    expect(new Set(segments.filter(({ scope }) => scope === "TEAM").map(({ teamId }) => teamId))).toEqual(
      new Set(teamIds)
    );
  });
});
