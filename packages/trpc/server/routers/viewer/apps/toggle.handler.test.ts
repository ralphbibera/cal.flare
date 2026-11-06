import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sendDisabledAppEmail } from "@calcom/emails/integration-email-service";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { mockDeep } from "vitest-mock-extended";
import type { TrpcSessionUser } from "../../../types";
import { toggleHandler } from "./toggle.handler";

vi.mock("@calcom/app-store/utils", () => ({
  getLocalAppMetadata: () => [{ slug: "tracking.app[0]", name: "Tracking", categories: ["analytics"] }],
}));
vi.mock("@calcom/emails/integration-email-service", () => ({ sendDisabledAppEmail: vi.fn() }));
vi.mock("@calcom/i18n/server", () => ({ getTranslation: async () => () => "translated" }));

describe("disabling event type apps", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const slug = "tracking.app[0]";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-toggle-app-"));
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
    await db
      .prepare("INSERT INTO users (id, uuid, email) VALUES (1, 'app-owner', 'owner@example.invalid')")
      .run();
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("changes and notifies only boolean-enabled events without awaiting notification delivery", async () => {
    const enabledMetadata = {
      note: "retained",
      apps: { [slug]: { enabled: true, trackingId: "keep" }, other: { enabled: true } },
    };
    const metadata = [
      enabledMetadata,
      { apps: { [slug]: { enabled: "true" } } },
      { apps: { [slug]: { enabled: false } } },
      { apps: { [slug]: { enabled: null } } },
      { apps: { [slug]: {} } },
      { apps: { tracking: { app: [{ enabled: true }] } } },
      {},
      null,
    ];
    for (const [index, value] of metadata.entries()) {
      await db
        .prepare('INSERT INTO "EventType" (id, title, slug, length, metadata) VALUES (?, ?, ?, 30, ?)')
        .bind(index + 1, `Event ${index + 1}`, `event-${index + 1}`, JSON.stringify(value))
        .run();
      await db
        .prepare('INSERT INTO "_user_eventtype" (A, B) VALUES (?, 1)')
        .bind(index + 1)
        .run();
    }
    const delivery = Promise.withResolvers<void>();
    vi.mocked(sendDisabledAppEmail).mockImplementation(() => delivery.promise);
    try {
      expect(
        await withD1Database({ DB: db }, () =>
          toggleHandler({
            input: { slug, enabled: false },
            ctx: { prisma, user: mockDeep<NonNullable<TrpcSessionUser>>() },
          })
        )
      ).toBe(false);
      await vi.waitFor(() => expect(sendDisabledAppEmail).toHaveBeenCalledTimes(1));
      expect(sendDisabledAppEmail).toHaveBeenCalledWith(
        expect.objectContaining({ email: "owner@example.invalid", eventTypeId: 1, title: "Event 1" })
      );
      const events = await withD1Database({ DB: db }, () =>
        prisma.eventType.findMany({ orderBy: { id: "asc" }, select: { metadata: true } })
      );
      expect(events.map((event) => event.metadata)).toEqual([
        {
          ...enabledMetadata,
          apps: { ...enabledMetadata.apps, [slug]: { enabled: false, trackingId: "keep" } },
        },
        ...metadata.slice(1),
      ]);
    } finally {
      delivery.resolve();
    }
  });
});
