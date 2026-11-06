import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventTypeRepository } from "./eventTypeRepository";

const COUNT = 250;

describe("eventTypeRepository reads over long id lists on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ids = Array.from({ length: COUNT }, (_, index) => index + 1);
  const repository = new EventTypeRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-event-type-large-lists-"));
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
    await db.batch([
      db
        .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (1, ?, ?)')
        .bind("org-owner", "owner@example.invalid"),
      db
        .prepare('INSERT INTO "Team" ("id", "name", "slug") VALUES (1, ?, ?)')
        .bind("Organization", "organization"),
      ...ids.map((id) =>
        db
          .prepare('INSERT INTO "Team" ("id", "name", "slug", "parentId") VALUES (?, ?, ?, 1)')
          .bind(id + 1, `Child ${id}`, `child-${id}`)
      ),
      db
        .prepare(
          'INSERT INTO "Profile" ("uid", "userId", "organizationId", "username", "updatedAt") VALUES (?, 1, 1, ?, ?)'
        )
        .bind("owner-profile", "owner", "2026-01-01T00:00:00.000+00:00"),
      ...ids.map((id) =>
        db
          .prepare(
            'INSERT INTO "EventType" ("id", "title", "slug", "length", "teamId") VALUES (?, ?, ?, 30, ?)'
          )
          .bind(id, `Team event ${id}`, `team-event-${id}`, id + 1)
      ),
      db
        .prepare(
          'INSERT INTO "EventType" ("id", "title", "slug", "length", "userId") VALUES (1000, ?, ?, 30, 1)'
        )
        .bind("Owner event", "owner-event"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("finds event types without children for a long id list", async () => {
    const eventTypes = await inD1(() => repository.findEventTypesWithoutChildren(ids));
    expect(eventTypes.map(({ id }) => id).sort((left, right) => left - right)).toEqual(ids);
  });

  it("lists event types for every child team of an organization", async () => {
    const eventTypes = await inD1(() =>
      repository.getEventTypeList({
        teamId: null,
        userId: null,
        isAll: true,
        user: { id: 1, organizationId: 1, isOwnerAdminOfParentTeam: true },
      })
    );
    expect(eventTypes.map(({ id }) => id).sort((left, right) => left - right)).toEqual([...ids, 1000]);
  });

  it("reads an org admin event type when the org has many teams and members", async () => {
    const eventType = await inD1(() => repository.findByIdForOrgAdmin({ id: 1000, organizationId: 1 }));
    expect(eventType).toMatchObject({ id: 1000, title: "Owner event" });
  });
});
