import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserRepository } from "./UserRepository";

const COUNT = 250;
describe("UserRepository reads over long id lists on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ids = Array.from({ length: COUNT }, (_, index) => index + 1);
  const repository = new UserRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-user-large-lists-"));
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
      ids.map((id) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email", "name", "locked") VALUES (?, ?, ?, ?, 0)')
          .bind(id, `large-user-${id}`, `large-user-${id}@example.invalid`, `User ${id}`)
      )
    );
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("finds every user by a long id list", async () => {
    const result = await inD1(() => repository.findByIdsWithPagination({ ids }));
    expect(result.users.map(({ id }) => id)).toEqual(ids);
    expect(result.total).toBe(COUNT);
  });

  it("pages a long id list without changing order or totals", async () => {
    const first = await inD1(() => repository.findByIdsWithPagination({ ids, limit: 10 }));
    expect(first.users.map(({ id }) => id)).toEqual(ids.slice(0, 10));
    expect(first).toMatchObject({ nextCursor: 10, total: COUNT });

    const second = await inD1(() =>
      repository.findByIdsWithPagination({ ids, limit: 10, cursor: first.nextCursor })
    );
    expect(second.users.map(({ id }) => id)).toEqual(ids.slice(10, 20));
    expect(second).toMatchObject({ nextCursor: 20, total: undefined });
  });

  it("searches inside a long id list", async () => {
    await db.prepare('UPDATE "users" SET "name" = ? WHERE "id" = ?').bind("Target person", COUNT).run();
    const result = await inD1(() => repository.findByIdsWithPagination({ ids, search: "target" }));
    expect(result.users.map(({ id }) => id)).toEqual([COUNT]);
    expect(result.total).toBe(1);
  });
});
