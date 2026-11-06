import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EventTypeRepository } from "./eventTypeRepository";

type EventTypeRow = [id: number, title: string, position: number, userId: number, parentId: number | null];

describe("event type title search", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const repository = new EventTypeRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-event-type-search-"));
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
    const personal: EventTypeRow[] = [
      [1, "İlker sync", 100, 1, null],
      [2, "ILKER intro", 90, 1, null],
      [3, "ılgaz chat", 80, 1, null],
      [4, "Σofia review", 70, 1, null],
      [5, "100%_real", 60, 1, null],
      [6, "unrelated", 50, 1, null],
      [7, "ilker managed child", 95, 1, 900],
      [8, "ilker someone else", 100, 2, null],
      [9, "ilker profile", 100, 3, null],
      ...Array.from(
        { length: 110 },
        (_, index): EventTypeRow => [200 + index, `Filler ${index}`, 40, 1, null]
      ),
      [320, "ilker after filler", 10, 1, null],
    ];
    const insertPersonal = personal.map(([id, title, position, userId, parentId]) =>
      db
        .prepare(
          'INSERT INTO "EventType" ("id", "title", "slug", "length", "position", "userId", "parentId") VALUES (?, ?, ?, 30, ?, ?, ?)'
        )
        .bind(id, title, `personal-${id}`, position, userId, parentId)
    );
    await db.batch([
      db.prepare(
        `INSERT INTO "users" ("id", "uuid", "email") VALUES (1, 'u1', 'one@example.invalid'), (2, 'u2', 'two@example.invalid'), (3, 'u3', 'three@example.invalid')`
      ),
      db.prepare(
        `INSERT INTO "Team" ("id", "name", "isOrganization") VALUES (1, 'Team', 0), (2, 'Other', 0), (3, 'Org', 1)`
      ),
      db.prepare(
        `INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (1, 1, 1, 'MEMBER')`
      ),
      db
        .prepare(
          `INSERT INTO "Profile" ("id", "uid", "userId", "organizationId", "username", "updatedAt") VALUES (1, 'profile-uid', 3, 3, 'profile-owner', ?)`
        )
        .bind("2026-11-06T00:00:00.000+00:00"),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length", "teamId", "schedulingType") VALUES
          (900, 'Managed parent', 'managed-parent', 30, 2, 'managed'),
          (400, 'İlker team', 'team-400', 30, 1, 'collective'),
          (401, 'ILKER round', 'team-401', 30, 1, 'roundRobin'),
          (402, 'unrelated team', 'team-402', 30, 1, 'collective'),
          (403, 'ilker elsewhere', 'team-403', 30, 2, 'collective')`
      ),
    ]);
    for (let index = 0; index < insertPersonal.length; index += 50) {
      await db.batch(insertPersonal.slice(index, index + 50));
    }
    await db.prepare(`UPDATE "EventType" SET "profileId" = 1 WHERE "id" = 9`).run();

    const owners: Array<[id: number, name: string | null, email: string]> = [
      [10, "İlker", "first@example.invalid"],
      [11, "Unrelated", "İ@example.invalid"],
      [12, "ILKER", "third@example.invalid"],
      [13, "ılgaz", "dotless@example.invalid"],
      [14, "Σofia", "sigma@example.invalid"],
      [15, null, "ilker-null-name@example.invalid"],
      [16, "100%_real", "wild@example.invalid"],
      [17, "ilker excluded", "excluded@example.invalid"],
    ];
    await db.batch([
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length", "teamId", "schedulingType") VALUES (500, 'Parent', 'parent', 30, 2, 'managed')`
      ),
      ...owners.flatMap(([id, name, email]) => [
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email", "name") VALUES (?, ?, ?, ?)')
          .bind(id, `owner-${id}`, email, name),
        db
          .prepare(
            'INSERT INTO "EventType" ("id", "title", "slug", "length", "parentId", "userId") VALUES (?, ?, ?, 30, 500, ?)'
          )
          .bind(500 + id, `Child ${id}`, `child-${id}`, id),
      ]),
      db.prepare(
        `INSERT INTO "EventType" ("id", "title", "slug", "length", "parentId") VALUES (540, 'Ownerless', 'ownerless', 30, 500)`
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const orderBy: Prisma.EventTypeOrderByWithRelationInput[] = [{ position: "desc" }, { id: "desc" }];
  const ids = (rows: Array<{ id: number }>) => rows.map(({ id }) => id);

  describe("findAllByUpId", () => {
    const personal = (
      options: { titleSearch?: string; limit?: number; cursor?: number; parentId?: Prisma.IntNullableFilter },
      upId = "usr-1",
      userId = 1
    ) =>
      inD1(() =>
        repository.findAllByUpId(
          { upId, userId },
          {
            where: { teamId: null, schedulingType: null, parentId: options.parentId ?? null },
            orderBy,
            limit: options.limit ?? 10,
            cursor: options.cursor,
            titleSearch: options.titleSearch,
          }
        )
      );

    it("folds Unicode in titles as PostgreSQL ILIKE does, in the requested order", async () => {
      expect(ids(await personal({ titleSearch: "İLKER" }))).toEqual([1, 2, 320]);
      expect(ids(await personal({ titleSearch: "İLKER", parentId: { not: null } }))).toEqual([7]);
      expect(ids(await personal({ titleSearch: "ı" }))).toEqual([3]);
      expect(ids(await personal({ titleSearch: "σOFIA" }))).toEqual([4]);
    });

    it("keeps wildcard characters in a search as pattern syntax", async () => {
      expect(ids(await personal({ titleSearch: "1%_R" }))).toEqual([5]);
    });

    it("scans past non-matching batches before cutting the page, resuming from the cursor row", async () => {
      expect(ids(await personal({ titleSearch: "ilker", limit: 1 }))).toEqual([1, 2]);
      expect(ids(await personal({ titleSearch: "ilker", limit: 1, cursor: 2 }))).toEqual([2, 320]);
      expect(ids(await personal({ titleSearch: "ilker", limit: 1, cursor: 320 }))).toEqual([320]);
    });

    it("positions a cursor that does not match the search, and finds nothing for a missing cursor row", async () => {
      expect(ids(await personal({ titleSearch: "ilker", cursor: 3 }))).toEqual([320]);
      expect(ids(await personal({ titleSearch: "ilker", cursor: 9999 }))).toEqual([]);
      expect(ids(await personal({ cursor: 9999 }))).toEqual([]);
    });

    it("keeps unsearched pages unchanged", async () => {
      expect(ids(await personal({ limit: 3 }))).toEqual([1, 2, 3, 4]);
    });

    it("searches only the profile's rows for a profile upId", async () => {
      expect(ids(await personal({ titleSearch: "ilker" }, "prof-profile-uid", 3))).toEqual([9]);
    });

    it("loads a searched page beyond D1's bound parameter limit with the full selection", async () => {
      const rows = await personal({ titleSearch: "filler", limit: 105 });
      expect(ids(rows)).toEqual(Array.from({ length: 106 }, (_, index) => 309 - index));
      expect(rows[0]).toMatchObject({ title: "Filler 109", position: 40, children: [], hosts: [] });
    });
  });

  describe("findTeamEventTypes", () => {
    const team = (teamId: number, titleSearch?: string) =>
      inD1(() => repository.findTeamEventTypes({ teamId, userId: 1, orderBy, limit: 10, titleSearch }));

    it("searches only the requested team's rows", async () => {
      expect(ids(await team(1, "İlker"))).toEqual([401, 400]);
      expect(ids(await team(1))).toEqual([402, 401, 400]);
    });

    it("still rejects users outside the team", async () => {
      await expect(team(2, "ilker")).rejects.toThrow("not a member");
    });
  });

  describe("listChildEventTypes", () => {
    const list = (input: Partial<Parameters<EventTypeRepository["listChildEventTypes"]>[0]>) =>
      inD1(() => repository.listChildEventTypes({ parentEventTypeId: 500, limit: 10, ...input }));
    const childIds = async (input: Parameters<typeof list>[0]) => ids((await list(input)).items);

    it("folds Unicode across owner name and email, ignoring ownerless children", async () => {
      const dotted = await list({ searchTerm: "İLKER" });
      expect(ids(dotted.items)).toEqual([510, 512, 515, 517]);
      expect(dotted).toMatchObject({ totalCount: 4, hasMore: false, nextCursor: null });
      expect(await childIds({ searchTerm: "ı" })).toEqual([513]);
      expect(await childIds({ searchTerm: "σOFIA" })).toEqual([514]);
    });

    it("treats wildcards as pattern syntax, so % matches every owned child", async () => {
      expect(await childIds({ searchTerm: "1%_R" })).toEqual([516]);
      expect(await childIds({ searchTerm: "%" })).toEqual([510, 511, 512, 513, 514, 515, 516, 517]);
    });

    it("excludes the given owner from matches and the count", async () => {
      const result = await list({ searchTerm: "ilker", excludeUserId: 17 });
      expect(ids(result.items)).toEqual([510, 512, 515]);
      expect(result.totalCount).toBe(3);
    });

    it("pages matches with a total of every match, resuming after the cursor", async () => {
      const first = await list({ searchTerm: "ilker", limit: 2 });
      expect(ids(first.items)).toEqual([510, 512]);
      expect(first).toMatchObject({ totalCount: 4, hasMore: true, nextCursor: 512 });

      const second = await list({ searchTerm: "ilker", limit: 2, cursor: 512 });
      expect(ids(second.items)).toEqual([515, 517]);
      expect(second).toMatchObject({ totalCount: 4, hasMore: false, nextCursor: null });
    });

    it("skips the first match after a cursor that does not match, and finds nothing for a missing one", async () => {
      expect(await childIds({ searchTerm: "ilker", cursor: 511 })).toEqual([515, 517]);
      expect(await childIds({ cursor: 505 })).toEqual([]);
      const missing = await list({ searchTerm: "ilker", cursor: 505 });
      expect(missing).toMatchObject({ items: [], totalCount: 4 });
    });

    it("returns the same selection whether or not a search ran", async () => {
      const [unsearched] = (await list({ limit: 1 })).items;
      const [searched] = (await list({ searchTerm: "İlker", limit: 1 })).items;
      expect(searched).toEqual(unsearched);
    });
  });
});
