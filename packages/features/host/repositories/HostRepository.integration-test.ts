import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { HostRepository } from "./HostRepository";

describe("host locations and conferencing credentials", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-host-categories-"));
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
      ...[
        [1, "Zed", null],
        [2, "Alex", '{"source":"original"}'],
        [3, "Alex", "null"],
        [4, null, "[]"],
        [5, "Outsider", null],
      ].map(([id, name, metadata]) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email", "name", "metadata") VALUES (?, ?, ?, ?, ?)')
          .bind(id, `host-user-${id}`, `host${id}@example.invalid`, name, metadata)
      ),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length") VALUES (1, 'Event', 'event', 30), (2, 'Other', 'other', 30)`
      ),
      ...[
        ["video", '["video","video"]', 0],
        ["conference", '["conferencing"]', 1],
        ["calendar", '["calendar"]', 1],
        ["absent", null, 1],
      ].map(([slug, categories, enabled]) =>
        db
          .prepare(
            'INSERT INTO "App" ("slug", "dirName", "categories", "enabled", "updatedAt") VALUES (?, ?, ?, ?, ?)'
          )
          .bind(slug, slug, categories, enabled, "2026-11-05T00:00:00.000+00:00")
      ),
      ...[
        [1, "calendar", 1, null],
        [2, "video", 2, 1],
        [3, "conference", 2, 0],
        [4, "video", 3, null],
        [5, null, 4, 0],
        [6, "absent", 4, 0],
        [7, "calendar", 2, 0],
      ].map(([id, appId, userId, invalid]) =>
        db
          .prepare(
            'INSERT INTO "Credential" ("id", "type", "key", "encryptedKey", "appId", "userId", "invalid") VALUES (?, ?, ?, ?, ?, ?, ?)'
          )
          .bind(id, "video", '{"secret":"must-not-escape"}', "also-private", appId, userId, invalid)
      ),
      ...[
        [1, 1, null, 0],
        [2, 1, 1, 1],
        [3, 1, null, 0],
        [4, 1, 1, 0],
        [5, 2, 1, 0],
      ].map(([userId, eventTypeId, priority, isFixed]) =>
        db
          .prepare('INSERT INTO "Host" ("userId", "eventTypeId", "priority", "isFixed") VALUES (?, ?, ?, ?)')
          .bind(userId, eventTypeId, priority, isFixed)
      ),
      db
        .prepare(
          `INSERT INTO "HostLocation" ("id", "userId", "eventTypeId", "type", "credentialId", "link", "updatedAt") VALUES ('location', 2, 1, 'video', 2, 'https://meeting.invalid/', ?)`
        )
        .bind("2026-11-05T00:00:00.000+00:00"),
    ]);
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const repository = new HostRepository(prisma);
  it("retains event scope, PostgreSQL null ordering, locations and exact safe credential fields", async () => {
    const hosts = await withD1Database({ DB: db }, () => repository.findHostsWithLocationOptions(1));
    expect(hosts.map(({ userId }) => userId)).toEqual([3, 2, 1, 4]);
    expect(hosts.find(({ userId }) => userId === 2)).toEqual({
      userId: 2,
      isFixed: true,
      priority: 1,
      location: {
        id: "location",
        type: "video",
        credentialId: 2,
        link: "https://meeting.invalid/",
        address: null,
        phoneNumber: null,
      },
      user: {
        id: 2,
        name: "Alex",
        email: "host2@example.invalid",
        avatarUrl: null,
        metadata: { source: "original" },
        credentials: [
          {
            id: 2,
            type: "video",
            userId: 2,
            teamId: null,
            appId: "video",
            invalid: true,
            delegationCredentialId: null,
            user: { email: "host2@example.invalid" },
          },
          {
            id: 3,
            type: "video",
            userId: 2,
            teamId: null,
            appId: "conference",
            invalid: false,
            delegationCredentialId: null,
            user: { email: "host2@example.invalid" },
          },
        ],
      },
    });
    expect(hosts.find(({ userId }) => userId === 1)).toMatchObject({
      location: null,
      user: { metadata: null, credentials: [] },
    });
    expect(hosts.find(({ userId }) => userId === 3)?.user.metadata).toBeNull();
    expect(hosts.find(({ userId }) => userId === 4)?.user).toMatchObject({ metadata: [], credentials: [] });
    expect(JSON.stringify(hosts)).not.toContain("private");
    expect(await withD1Database({ DB: db }, () => repository.findHostsWithLocationOptions(999))).toEqual([]);
  });

  it("paginates hosts before projecting credentials, retaining hosts without matching apps", async () => {
    const first = await withD1Database({ DB: db }, () =>
      repository.findHostsWithLocationOptionsPaginated({ eventTypeId: 1, limit: 2 })
    );
    expect(first.items.map(({ userId }) => userId)).toEqual([1, 2]);
    expect(first).toMatchObject({ hasMore: true, nextCursor: 2 });
    const last = await withD1Database({ DB: db }, () =>
      repository.findHostsWithLocationOptionsPaginated({ eventTypeId: 1, limit: 2, cursor: first.nextCursor })
    );
    expect(last.items.map(({ userId }) => userId)).toEqual([3, 4]);
    expect(last).toMatchObject({ hasMore: false, nextCursor: undefined });
    const zero = await withD1Database({ DB: db }, () =>
      repository.findHostsWithLocationOptionsPaginated({ eventTypeId: 1, limit: 2, cursor: 0 })
    );
    expect(zero).toEqual(first);
  });

  it("returns only the conferencing selection, preserving empty child relations and duplicate membership", async () => {
    const hosts = await withD1Database({ DB: db }, () => repository.findHostsWithConferencingCredentials(1));
    expect(hosts.toSorted((a, b) => a.userId - b.userId)).toEqual([
      { userId: 1, user: { credentials: [] } },
      {
        userId: 2,
        user: {
          credentials: [
            { id: 2, type: "video", appId: "video" },
            { id: 3, type: "video", appId: "conference" },
          ],
        },
      },
      { userId: 3, user: { credentials: [{ id: 4, type: "video", appId: "video" }] } },
      { userId: 4, user: { credentials: [] } },
    ]);
  });
});
