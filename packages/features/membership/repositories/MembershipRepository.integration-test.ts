import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MembershipRepository } from "./MembershipRepository";

describe("searchMembers", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const repository = new MembershipRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const userIds = (result: Awaited<ReturnType<MembershipRepository["searchMembers"]>>) =>
    result.memberships.map(({ user }) => user.id);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-member-search-"));
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
    const filler = Array.from({ length: 120 }, (_, index) => 100 + index);
    await db.batch([
      ...[
        [1, "İlker", "first@example.invalid"],
        [2, "Unrelated", "İ@example.invalid"],
        [3, "ILKER", "third@example.invalid"],
        [4, "ılgaz", "dotless@example.invalid"],
        [5, "Σofia", "sigma@example.invalid"],
        [6, null, "ilker-null-name@example.invalid"],
        [7, "100%_real", "wild@example.invalid"],
        [8, "ilker pending", "pending@example.invalid"],
        [9, "ilker other team", "other@example.invalid"],
        ...filler.map((id) => [id, `Filler ${id}`, `filler${id}@example.invalid`]),
        [300, "ilker after filler", "after@example.invalid"],
      ].map(([id, name, email]) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email", "name") VALUES (?, ?, ?, ?)')
          .bind(id, `member-${id}`, email, name)
      ),
      db.prepare(`INSERT INTO "Team" ("id", "name") VALUES (1, 'Team'), (2, 'Other')`),
      ...[1, 2, 3, 4, 5, 6, 7, ...filler, 300].map((userId) =>
        db
          .prepare(
            `INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (1, ?, 1, 'MEMBER')`
          )
          .bind(userId)
      ),
      db.prepare(
        `INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (1, 8, 0, 'MEMBER')`
      ),
      db.prepare(
        `INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (2, 9, 1, 'ADMIN')`
      ),
    ]);
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("folds Unicode as PostgreSQL did across name and email, within accepted team members", async () => {
    const dotted = await inD1(() => repository.searchMembers({ teamId: 1, search: "İLKER", limit: 10 }));
    expect(userIds(dotted)).toEqual([1, 3, 6, 300]);

    const dotless = await inD1(() => repository.searchMembers({ teamId: 1, search: "ı", limit: 10 }));
    expect(userIds(dotless)).toEqual([4]);

    const sigma = await inD1(() => repository.searchMembers({ teamId: 1, search: "σOFIA", limit: 10 }));
    expect(userIds(sigma)).toEqual([5]);
  });

  it("keeps wildcard characters in a search as PostgreSQL pattern syntax", async () => {
    const wildcard = await inD1(() => repository.searchMembers({ teamId: 1, search: "1%_R", limit: 10 }));
    expect(userIds(wildcard)).toEqual([7]);
  });

  it("matches across scan batches before paging, resuming from the cursor", async () => {
    const first = await inD1(() => repository.searchMembers({ teamId: 1, search: "ilker", limit: 2 }));
    expect(userIds(first)).toEqual([1, 3]);
    expect(first).toMatchObject({ hasMore: true, nextCursor: 3 });

    const second = await inD1(() =>
      repository.searchMembers({ teamId: 1, search: "ilker", limit: 2, cursor: first.nextCursor })
    );
    expect(userIds(second)).toEqual([6, 300]);
    expect(second).toMatchObject({ hasMore: false, nextCursor: undefined });
  });

  it("stays within the member filter while searching", async () => {
    const result = await inD1(() =>
      repository.searchMembers({ teamId: 1, search: "ilker", limit: 10, memberUserIds: [3, 4, 9] })
    );
    expect(userIds(result)).toEqual([3]);

    const none = await inD1(() =>
      repository.searchMembers({ teamId: 1, search: "ilker", limit: 10, memberUserIds: [] })
    );
    expect(none.memberships).toEqual([]);
  });

  it("returns the exact member selection and leaves unsearched paging alone", async () => {
    const { memberships } = await inD1(() =>
      repository.searchMembers({ teamId: 1, search: "SIGMA@", limit: 10 })
    );
    expect(memberships).toEqual([
      {
        role: "MEMBER",
        user: {
          id: 5,
          name: "Σofia",
          email: "sigma@example.invalid",
          avatarUrl: null,
          username: null,
          defaultScheduleId: null,
        },
      },
    ]);

    const page = await inD1(() => repository.searchMembers({ teamId: 1, limit: 2, cursor: 2 }));
    expect(userIds(page)).toEqual([3, 4]);
    expect(page).toMatchObject({ hasMore: true, nextCursor: 4 });
  });
});
