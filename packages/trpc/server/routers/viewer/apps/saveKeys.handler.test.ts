import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import { ZodError } from "zod";
import type { TrpcSessionUser } from "../../../types";
import { listLocalHandler } from "./listLocal.handler";
import { saveKeysHandler } from "./saveKeys.handler";

const localApps = vi.hoisted(() => [
  {
    slug: "daily-video",
    dirName: "dailyvideo",
    name: "Cal Video",
    description: "Video conferencing",
    type: "daily_video",
    categories: ["video"],
  },
  {
    slug: "zoom",
    dirName: "zoomvideo",
    name: "Zoom",
    description: "Video conferencing",
    type: "zoom_video",
    categories: ["video"],
  },
]);

vi.mock("@calcom/app-store/utils", () => ({ getLocalAppMetadata: () => localApps }));

describe("saving admin app keys", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ctx = { user: mockDeep<NonNullable<TrpcSessionUser>>(), prisma };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-save-keys-"));
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

  beforeEach(async () => {
    await db.prepare('DELETE FROM "App"').run();
  });

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  async function insertDisabledApp() {
    await db
      .prepare(`INSERT INTO "App" ("slug", "dirName", "categories", "keys", "enabled", "updatedAt")
        VALUES ('daily-video', 'dailyvideo', '["video"]', '{"api_key":"existing"}', 0, '2026-11-05T00:00:00.000+00:00')`)
      .run();
  }

  it("creates a missing app with submitted keys and enables it when requested", async () => {
    await withD1Database({ DB: db }, () =>
      saveKeysHandler({
        ctx,
        input: {
          slug: "daily-video",
          dirName: "dailyvideo",
          type: "daily_video",
          keys: { api_key: "cal_live_key" },
          fromEnabled: true,
        },
      })
    );

    expect(
      await withD1Database({ DB: db }, () =>
        prisma.app.findUnique({
          where: { slug: "daily-video" },
          select: { keys: true, enabled: true, dirName: true, categories: true },
        })
      )
    ).toEqual({
      keys: { api_key: "cal_live_key" },
      enabled: true,
      dirName: "dailyvideo",
      categories: ["video"],
    });
  });

  it("updates keys while keeping the app disabled until it is enabled with new keys", async () => {
    await insertDisabledApp();
    await withD1Database({ DB: db }, () =>
      saveKeysHandler({
        ctx,
        input: {
          slug: "daily-video",
          dirName: "dailyvideo",
          type: "daily_video",
          keys: { api_key: "saved_but_disabled" },
        },
      })
    );

    expect(
      await withD1Database({ DB: db }, () =>
        prisma.app.findUnique({
          where: { slug: "daily-video" },
          select: { keys: true, enabled: true },
        })
      )
    ).toEqual({ keys: { api_key: "saved_but_disabled", scale_plan: "false" }, enabled: false });

    await withD1Database({ DB: db }, () =>
      saveKeysHandler({
        ctx,
        input: {
          slug: "daily-video",
          dirName: "dailyvideo",
          type: "daily_video",
          keys: { api_key: "enabled_key", scale_plan: "true" },
          fromEnabled: true,
        },
      })
    );
    expect(
      await withD1Database({ DB: db }, () =>
        prisma.app.findUnique({
          where: { slug: "daily-video" },
          select: { keys: true, enabled: true },
        })
      )
    ).toEqual({ keys: { api_key: "enabled_key", scale_plan: "true" }, enabled: true });
  });

  it("rejects an invalid key with the key schema error and leaves the stored row untouched", async () => {
    await insertDisabledApp();
    const error = await withD1Database({ DB: db }, () =>
      saveKeysHandler({
        ctx,
        input: {
          slug: "daily-video",
          dirName: "dailyvideo",
          type: "daily_video",
          keys: { api_key: "" },
          fromEnabled: true,
        },
      })
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ZodError);
    expect((error as ZodError).issues).toEqual([
      expect.objectContaining({ code: "too_small", path: ["api_key"] }),
    ]);
    expect(
      await withD1Database({ DB: db }, () =>
        prisma.app.findUnique({
          where: { slug: "daily-video" },
          select: { keys: true, enabled: true },
        })
      )
    ).toEqual({ keys: { api_key: "existing" }, enabled: false });

    const apps = await withD1Database({ DB: db }, () =>
      listLocalHandler({ ctx, input: { category: "video" } })
    );
    expect(apps.find((app) => app.slug === "daily-video")).toEqual(
      expect.objectContaining({ enabled: false, keys: { api_key: "existing" } })
    );
  });

  it("does not create a disabled app when its first submitted key is invalid", async () => {
    const error = await withD1Database({ DB: db }, () =>
      saveKeysHandler({
        ctx,
        input: {
          slug: "zoom",
          dirName: "zoomvideo",
          type: "zoom_video",
          keys: { client_id: "", client_secret: "" },
          fromEnabled: true,
        },
      })
    ).catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ZodError);
    expect(
      await withD1Database({ DB: db }, () =>
        prisma.app.findUnique({ where: { slug: "zoom" }, select: { slug: true } })
      )
    ).toBeNull();
  });
});
