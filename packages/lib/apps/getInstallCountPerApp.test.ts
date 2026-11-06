import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { computeInstallCountsFromDB } from "./getInstallCountPerApp";

describe("installed app counts", () => {
  let directory: string | undefined;
  let mf: Miniflare | undefined;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-app-counts-"));
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
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare('DELETE FROM "Credential"'),
      db.prepare('DELETE FROM "App"'),
      ...["popular", "disabled", "unused"].map((slug) =>
        db
          .prepare('INSERT INTO "App" ("slug", "dirName", "updatedAt", "enabled") VALUES (?, ?, ?, ?)')
          .bind(slug, slug, "2026-11-05T12:00:00.000+00:00", slug === "disabled" ? 0 : 1)
      ),
    ]);
  });

  it("returns an empty record when no app has credentials", async () => {
    expect(await withD1Database({ DB: db }, computeInstallCountsFromDB)).toEqual({});
  });

  it("counts credential rows, including invalid and disabled installs, and omits null app ids", async () => {
    await db.batch([
      ...[
        ["popular", 0],
        ["popular", 1],
        ["disabled", 0],
        [null, 0],
      ].map(([appId, invalid]) =>
        db
          .prepare('INSERT INTO "Credential" ("type", "key", "appId", "invalid") VALUES (?, ?, ?, ?)')
          .bind("calendar", "{}", appId, invalid)
      ),
    ]);
    const counts = await withD1Database({ DB: db }, computeInstallCountsFromDB);
    expect(counts).toEqual({ popular: 2, disabled: 1 });
    expect(Object.keys(counts)).toEqual(["popular", "disabled"]);
    expect(counts).not.toHaveProperty("unused");
  });
});
