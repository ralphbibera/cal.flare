import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mts";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getEventTypesPublic } from "./getEventTypesPublic";

describe("public organizer event types", () => {
  let root: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "public-event-types-"));
    await migrateD1({ persistTo: root });
    const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
    runtime = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      resourcePersistencePath: join(root, "v3"),
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
      .prepare("INSERT INTO users (id, uuid, email) VALUES (1, ?, ?)")
      .bind("owner", "owner@example.com")
      .run();
  }, 120_000);
  afterAll(async () => {
    await runtime?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  it("runs the original public owner/member union, filtering and projection on D1", async () =>
    withD1Database({ DB: db }, async () => {
      await db
        .prepare("INSERT INTO users (id, uuid, email) VALUES (10, ?, ?)")
        .bind("member", "member@example.com")
        .run();
      await db.prepare("INSERT INTO Team (id, name) VALUES (10, ?)").bind("Team").run();
      for (const [id, position, userId, teamId, hidden, metadata] of [
        [100, 2, 1, null, 0, '{"smartContractAddress":"valid"}'],
        [101, 3, 10, null, 0, null],
        [102, 3, 1, null, 0, "{}"],
        [103, 9, 1, null, 1, "{}"],
        [104, 9, 1, null, 0, '{"smartContractAddress":false}'],
        [105, 9, 1, 10, 0, "{}"],
        [106, 9, null, null, 0, "{}"],
      ] as const) {
        await db
          .prepare(`INSERT INTO EventType (id, title, slug, length, position, userId, teamId, hidden, metadata,
        schedulingType, description, recurringEvent, seatsPerTimeSlot) VALUES (?, ?, ?, 30, ?, ?, ?, ?, ?, 'roundRobin', '**safe**', '{"count":2}', 4)`)
          .bind(id, `Event ${id}`, `event-${id}`, position, userId, teamId, hidden, metadata)
          .run();
        await db.prepare("INSERT INTO _user_eventtype (A, B) VALUES (?, 1)").bind(id).run();
      }
      const events = await getEventTypesPublic(1);
      expect(events.map(({ id }) => id)).toEqual([101, 102, 100]);
      expect(events[0]).toMatchObject({
        schedulingType: "roundRobin",
        metadata: {},
        recurringEvent: { count: 2 },
        hidden: false,
        requiresConfirmation: false,
        canSendCalVideoTranscriptionEmails: true,
        descriptionAsSafeHTML: "<p><strong>safe</strong></p>\n",
      });
      expect(Object.keys(events[0]).sort()).toEqual(
        [
          "canSendCalVideoTranscriptionEmails",
          "currency",
          "description",
          "descriptionAsSafeHTML",
          "hidden",
          "id",
          "length",
          "lockTimeZoneToggleOnBookingPage",
          "lockedTimeZone",
          "metadata",
          "price",
          "recurringEvent",
          "requiresBookerEmailVerification",
          "requiresConfirmation",
          "schedulingType",
          "slug",
          "title",
        ].sort()
      );
      expect(await getEventTypesPublic(-1)).toEqual([]);
    }));
});
