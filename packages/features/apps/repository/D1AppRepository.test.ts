import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D1AppRepository } from "./D1AppRepository";

describe("apps by stored category", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-app-categories-"));
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
    for (const [slug, categories, enabled] of [
      ["both", '["video","calendar","video"]', 1],
      ["disabled", '["calendar"]', 0],
      ["empty", "[]", 1],
      ["absent", null, 1],
      ["other", '["other"]', 1],
    ] as const) {
      await db
        .prepare(`INSERT INTO "App" ("slug", "dirName", "categories", "enabled", "keys", "updatedAt")
        VALUES (?, ?, ?, ?, ?, ?)`)
        .bind(slug, slug, categories, enabled, '{"client_id":"configured"}', "2026-11-05T00:00:00.000+00:00")
        .run();
    }
  });

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("returns each matching app once, retaining disabled configuration and original selected fields", async () => {
    const apps = await withD1Database({ DB: db }, () => D1AppRepository.findLocalByCategory("calendar"));
    expect(apps.toSorted((a, b) => a.slug.localeCompare(b.slug))).toEqual([
      { slug: "both", dirName: "both", keys: { client_id: "configured" }, enabled: true },
      { slug: "disabled", dirName: "disabled", keys: { client_id: "configured" }, enabled: false },
    ]);
    expect(await withD1Database({ DB: db }, () => D1AppRepository.findLocalByCategory("video"))).toEqual([
      { slug: "both", dirName: "both", keys: { client_id: "configured" }, enabled: true },
    ]);
  });

  it("lists only enabled matching slugs without returning keys or other configuration", async () => {
    expect(
      await withD1Database({ DB: db }, () => D1AppRepository.findEnabledSlugsByCategory("calendar"))
    ).toEqual([{ slug: "both" }]);
    expect(await withD1Database({ DB: db }, () => D1AppRepository.findEnabledSlugsByCategory("crm"))).toEqual(
      []
    );
  });

  it("reads changed categories and selected configuration together", async () => {
    await db
      .prepare('UPDATE "App" SET "categories" = ?, "keys" = ? WHERE "slug" = ?')
      .bind('["crm","crm"]', '{"client_id":"changed"}', "other")
      .run();
    expect(await withD1Database({ DB: db }, () => D1AppRepository.findLocalByCategory("other"))).toEqual([]);
    expect(await withD1Database({ DB: db }, () => D1AppRepository.findLocalByCategory("crm"))).toEqual([
      { slug: "other", dirName: "other", keys: { client_id: "changed" }, enabled: true },
    ]);
  });
});
