import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { TrpcSessionUser } from "../../../types";
import { listLocalHandler } from "./listLocal.handler";

const localApps = vi.hoisted(() => [
  {
    slug: "daily-video",
    dirName: "dailyvideo",
    name: "Cal Video",
    description: "Video conferencing",
    type: "daily_video",
    category: "video",
    categories: ["video"],
  },
  {
    slug: "zoom",
    dirName: "zoomvideo",
    name: "Zoom",
    description: "Video conferencing",
    type: "zoom_video",
    category: "video",
    categories: ["video"],
  },
  {
    slug: "google-calendar",
    dirName: "googlecalendar",
    name: "Google Calendar",
    description: "Calendar",
    type: "google_calendar",
    category: "calendar",
    categories: ["calendar"],
  },
]);

vi.mock("@calcom/app-store/utils", () => ({ getLocalAppMetadata: () => localApps }));

describe("listing local apps for the admin view", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ctx = { user: mockDeep<NonNullable<TrpcSessionUser>>(), prisma };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-list-local-"));
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
    await db.batch([
      db.prepare(`INSERT INTO "App" ("slug", "dirName", "categories", "keys", "enabled", "updatedAt")
          VALUES ('daily-video', 'dailyvideo', '["video"]', NULL, 0, '2026-11-05T00:00:00.000+00:00')`),
      db.prepare(`INSERT INTO "App" ("slug", "dirName", "categories", "keys", "enabled", "updatedAt")
          VALUES ('zoom', 'zoomvideo', '["video"]', '{"client_id":"zoom-id","client_secret":"zoom-secret"}', 1, '2026-11-05T00:00:00.000+00:00')`),
    ]);
  });

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("returns stored keys and enablement beside empty schema fields", async () => {
    const apps = await withD1Database({ DB: db }, () =>
      listLocalHandler({ ctx, input: { category: "video" } })
    );

    expect(apps).toEqual([
      {
        name: "Cal Video",
        slug: "daily-video",
        logo: undefined,
        title: undefined,
        type: "daily_video",
        description: "Video conferencing",
        enabled: false,
        dirName: "dailyvideo",
        keys: { api_key: "", scale_plan: "" },
      },
      {
        name: "Zoom",
        slug: "zoom",
        logo: undefined,
        title: undefined,
        type: "zoom_video",
        description: "Video conferencing",
        enabled: true,
        dirName: "zoomvideo",
        keys: { client_id: "zoom-id", client_secret: "zoom-secret" },
      },
    ]);
  });

  it("lists apps with no stored row as disabled with empty schema fields", async () => {
    await db.prepare('DELETE FROM "App"').run();

    expect(
      await withD1Database({ DB: db }, () => listLocalHandler({ ctx, input: { category: "video" } }))
    ).toEqual([
      expect.objectContaining({
        slug: "daily-video",
        enabled: false,
        dirName: "dailyvideo",
        keys: { api_key: "", scale_plan: "" },
      }),
      expect.objectContaining({
        slug: "zoom",
        enabled: false,
        dirName: "zoomvideo",
        keys: { client_id: "", client_secret: "" },
      }),
    ]);
  });

  it("uses the stored category to scope rows and keeps other categories out", async () => {
    await db
      .prepare(`INSERT INTO "App" ("slug", "dirName", "categories", "keys", "enabled", "updatedAt")
        VALUES ('google-calendar', 'googlecalendar', '["calendar"]', '{"client_id":"g-id","client_secret":"g-secret","redirect_uris":["https://cal.local/callback"]}', 1, '2026-11-05T00:00:00.000+00:00')`)
      .run();

    expect(
      await withD1Database({ DB: db }, () => listLocalHandler({ ctx, input: { category: "calendar" } }))
    ).toEqual([
      {
        name: "Google Calendar",
        slug: "google-calendar",
        logo: undefined,
        title: undefined,
        type: "google_calendar",
        description: "Calendar",
        enabled: true,
        dirName: "googlecalendar",
        keys: {
          client_id: "g-id",
          client_secret: "g-secret",
          redirect_uris: ["https://cal.local/callback"],
        },
      },
    ]);
  });
});
