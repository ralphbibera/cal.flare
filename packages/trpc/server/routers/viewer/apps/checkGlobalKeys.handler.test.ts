import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { TrpcSessionUser } from "../../../types";
import { checkForGlobalKeysHandler } from "./checkGlobalKeys.handler";

describe("checking globally configured app keys", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ctx = { user: mockDeep<NonNullable<TrpcSessionUser>>() };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-global-keys-"));
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
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("reports a configured app whether or not it is enabled", async () => {
    await db.batch([
      db.prepare(`INSERT INTO "App" ("slug", "dirName", "enabled", "updatedAt")
          VALUES ('daily-video', 'dailyvideo', 0, '2026-11-05T00:00:00.000+00:00')`),
      db.prepare(`INSERT INTO "App" ("slug", "dirName", "enabled", "updatedAt")
          VALUES ('zoom', 'zoomvideo', 1, '2026-11-05T00:00:00.000+00:00')`),
    ]);

    const results = await withD1Database({ DB: db }, () =>
      Promise.all(
        ["daily-video", "zoom", "unknown-app"].map((slug) =>
          checkForGlobalKeysHandler({ ctx, input: { slug } })
        )
      )
    );
    expect(results).toEqual([true, true, false]);
  });

  it("stops reporting an app once its global row is removed", async () => {
    await db.prepare('DELETE FROM "App" WHERE "slug" = ?').bind("daily-video").run();

    expect(
      await withD1Database({ DB: db }, () =>
        checkForGlobalKeysHandler({ ctx, input: { slug: "daily-video" } })
      )
    ).toBe(false);
  });
});
