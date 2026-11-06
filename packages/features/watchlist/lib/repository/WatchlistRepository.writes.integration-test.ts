import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { WatchlistAction, WatchlistSource, WatchlistType } from "@calcom/prisma/enums";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { WatchlistRepository } from "./WatchlistRepository";

const d1DateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/;
const uuidV7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const entry = {
  type: WatchlistType.EMAIL,
  value: "spam@example.com",
  organizationId: 1,
  action: WatchlistAction.BLOCK,
  description: "Spam",
  userId: 7,
};

describe("watchlist writes on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const repository = new WatchlistRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const rows = async () => ({
    entries: (await db.prepare('SELECT "id", "value" FROM "Watchlist" ORDER BY "value"').all()).results,
    audits: (
      await db
        .prepare(
          'SELECT "id", "watchlistId", "value", "changedByUserId", "changedAt" FROM "WatchlistAudit" ORDER BY "value"'
        )
        .all()
    ).results,
  });
  const failOn = (table: "Watchlist" | "WatchlistAudit", event: "INSERT" | "DELETE") =>
    db
      .prepare(`CREATE TRIGGER "fail_write" BEFORE ${event} ON "${table}"
        BEGIN SELECT RAISE(ABORT, 'forced late failure'); END`)
      .run();
  const seed = (...values: string[]) =>
    db.batch(
      values.map((value) =>
        db
          .prepare(
            `INSERT INTO "Watchlist" ("id", "type", "value", "organizationId", "action") VALUES (?, 'EMAIL', ?, 1, 'BLOCK')`
          )
          .bind(value, value)
      )
    );

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-watchlist-writes-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../apps/web/cloudflare.config")).default;
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
    await db.prepare(`INSERT INTO "Team" ("id", "name") VALUES (1, 'Org')`).run();
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare('DROP TRIGGER IF EXISTS "fail_write"'),
      db.prepare('DELETE FROM "WatchlistAudit"'),
      db.prepare('DELETE FROM "Watchlist"'),
    ]);
  });

  describe("createEntry", () => {
    it("creates the entry with its audit and returns the entry as Prisma reads it", () =>
      inD1(async () => {
        const created = await repository.createEntry(entry);

        expect(created).toEqual(await prisma.watchlist.findUniqueOrThrow({ where: { id: created.id } }));
        expect(created).toMatchObject({
          value: entry.value,
          isGlobal: false,
          source: WatchlistSource.MANUAL,
        });
        expect((await rows()).audits).toEqual([
          {
            id: expect.stringMatching(uuidV7),
            watchlistId: created.id,
            value: entry.value,
            changedByUserId: 7,
            changedAt: expect.stringMatching(d1DateTime),
          },
        ]);
      }));

    it("leaves no entry when the later audit insert fails", () =>
      inD1(async () => {
        await failOn("WatchlistAudit", "INSERT");

        await expect(repository.createEntry(entry)).rejects.toThrow(/forced late failure/);

        expect(await rows()).toEqual({ entries: [], audits: [] });
      }));

    it("lets one of two simultaneous identical entries win and fails the other with P2002", () =>
      inD1(async () => {
        const results = await Promise.allSettled([
          repository.createEntry(entry),
          repository.createEntry(entry),
        ]);

        expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(results.find(({ status }) => status === "rejected")).toMatchObject({
          reason: { code: "P2002", meta: { modelName: "Watchlist" } },
        });
        const { entries, audits } = await rows();
        expect(entries).toHaveLength(1);
        expect(audits).toHaveLength(1);
      }));
  });

  describe("deleteEntry", () => {
    it("audits the deletion and removes the entry", () =>
      inD1(async () => {
        await seed("a@example.com");

        await expect(repository.deleteEntry("a@example.com", 7)).resolves.toBeUndefined();

        expect(await rows()).toMatchObject({
          entries: [],
          audits: [{ watchlistId: null, value: "a@example.com", changedByUserId: 7 }],
        });
      }));

    it("leaves no audit when the later delete fails", () =>
      inD1(async () => {
        await seed("a@example.com");
        await failOn("Watchlist", "DELETE");

        await expect(repository.deleteEntry("a@example.com", 7)).rejects.toThrow(/forced late failure/);

        expect(await rows()).toMatchObject({ entries: [{ value: "a@example.com" }], audits: [] });
      }));

    it("lets one of two simultaneous deletes win with a single audit", () =>
      inD1(async () => {
        await seed("a@example.com");

        const results = await Promise.allSettled([
          repository.deleteEntry("a@example.com", 7),
          repository.deleteEntry("a@example.com", 8),
        ]);

        expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
        expect(await rows()).toMatchObject({ entries: [], audits: [{ watchlistId: null }] });
      }));
  });

  describe("bulkDeleteEntries", () => {
    it("audits every found entry, removes them and counts them", () =>
      inD1(async () => {
        await seed("a@example.com", "b@example.com", "keep@example.com");

        await expect(
          repository.bulkDeleteEntries({ ids: ["a@example.com", "b@example.com", "missing"], userId: 7 })
        ).resolves.toEqual({ deleted: 2 });

        const { entries, audits } = await rows();
        expect(entries).toEqual([{ id: "keep@example.com", value: "keep@example.com" }]);
        expect(audits).toMatchObject([
          {
            id: expect.stringMatching(uuidV7),
            watchlistId: null,
            value: "a@example.com",
            changedByUserId: 7,
          },
          {
            id: expect.stringMatching(uuidV7),
            watchlistId: null,
            value: "b@example.com",
            changedByUserId: 7,
          },
        ]);
      }));

    it("leaves no audits when the later delete fails", () =>
      inD1(async () => {
        await seed("a@example.com", "b@example.com");
        await failOn("Watchlist", "DELETE");

        await expect(
          repository.bulkDeleteEntries({ ids: ["a@example.com", "b@example.com"], userId: 7 })
        ).rejects.toThrow(/forced late failure/);

        expect(await rows()).toMatchObject({ entries: [{}, {}], audits: [] });
      }));

    it("lets one of two simultaneous bulk deletes win with one audit per entry", () =>
      inD1(async () => {
        await seed("a@example.com", "b@example.com");
        const ids = ["a@example.com", "b@example.com"];

        const results = await Promise.allSettled([
          repository.bulkDeleteEntries({ ids, userId: 7 }),
          repository.bulkDeleteEntries({ ids, userId: 8 }),
        ]);

        expect(results).toContainEqual({ status: "fulfilled", value: { deleted: 2 } });
        const { entries, audits } = await rows();
        expect(entries).toEqual([]);
        expect(audits).toHaveLength(2);
      }));
  });
});
