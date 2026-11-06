import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserRepository } from "./UserRepository";

describe("findByIdsWithPagination", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const repository = new UserRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  // D1 rejects `in` lists beyond its bound parameter limit, with or without a search.
  const filler = Array.from({ length: 80 }, (_, index) => 100 + index);
  const ids = [1, 2, 3, 4, 5, 6, 7, 8, ...filler, 300];

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-user-search-"));
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
    await db.batch(
      [
        [1, "İlker", "first@example.invalid", 0],
        [2, "Unrelated", "İ@example.invalid", 0],
        [3, "ILKER", "third@example.invalid", 0],
        [4, "ılgaz", "dotless@example.invalid", 0],
        [5, "Σofia", "sigma@example.invalid", 0],
        [6, null, "ilker-null-name@example.invalid", 0],
        [7, "100%_real", "wild@example.invalid", 0],
        [8, "ilker locked", "locked@example.invalid", 1],
        [9, "ilker out of scope", "other@example.invalid", 0],
        ...filler.map((id) => [id, `Filler ${id}`, `filler${id}@example.invalid`, 0]),
        [300, "ilker after filler", "after@example.invalid", 0],
      ].map(([id, name, email, locked]) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email", "name", "locked") VALUES (?, ?, ?, ?, ?)')
          .bind(id, `user-${id}`, email, name, locked)
      )
    );
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const scopedIds = (result: { users: Array<{ id: number }> }) => result.users.map(({ id }) => id);

  it("folds Unicode across name and email, inside the requested ids and without locked users", async () => {
    const dotted = await inD1(() => repository.findByIdsWithPagination({ ids, search: "İLKER" }));
    expect(scopedIds(dotted)).toEqual([1, 3, 6, 300]);
    expect(dotted).toMatchObject({ total: 4, nextCursor: undefined });

    const dotless = await inD1(() => repository.findByIdsWithPagination({ ids, search: "ı" }));
    expect(scopedIds(dotless)).toEqual([4]);

    const sigma = await inD1(() => repository.findByIdsWithPagination({ ids, search: "σOFIA" }));
    expect(sigma.users).toEqual([{ id: 5, name: "Σofia", email: "sigma@example.invalid" }]);
  });

  it("keeps wildcard characters in a search as PostgreSQL pattern syntax", async () => {
    const wildcard = await inD1(() => repository.findByIdsWithPagination({ ids, search: "1%_R" }));
    expect(scopedIds(wildcard)).toEqual([7]);
  });

  it("counts every match on the first page, including locked users as count() always has", async () => {
    const first = await inD1(() => repository.findByIdsWithPagination({ ids, search: "ilker", limit: 2 }));
    expect(scopedIds(first)).toEqual([1, 3]);
    expect(first).toMatchObject({ nextCursor: 3, total: 5 });

    const second = await inD1(() =>
      repository.findByIdsWithPagination({ ids, search: "ilker", limit: 2, cursor: first.nextCursor })
    );
    expect(scopedIds(second)).toEqual([6, 300]);
    expect(second).toMatchObject({ nextCursor: undefined, total: undefined });
  });

  it("leaves unsearched paging and totals alone", async () => {
    const small = [1, 2, 3, 8, 9];
    const all = await inD1(() => repository.findByIdsWithPagination({ ids: small }));
    expect(scopedIds(all)).toEqual([1, 2, 3, 9]);
    expect(all.total).toBe(4);

    const first = await inD1(() => repository.findByIdsWithPagination({ ids: small, limit: 2 }));
    expect(scopedIds(first)).toEqual([1, 2]);
    expect(first).toMatchObject({ nextCursor: 2, total: 5 });

    const second = await inD1(() => repository.findByIdsWithPagination({ ids: small, limit: 2, cursor: 2 }));
    expect(scopedIds(second)).toEqual([3, 9]);
    expect(second).toMatchObject({ nextCursor: undefined, total: undefined });
  });
});
