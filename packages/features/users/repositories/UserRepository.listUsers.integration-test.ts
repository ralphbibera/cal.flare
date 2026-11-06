import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserRepository } from "./UserRepository";

describe("listUsers search", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const repository = new UserRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  // More filler users than one candidate batch, so a prefilter that keeps every user still scans to the end.
  const fillerCount = 520;
  const userCount = fillerCount + 9;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-list-users-"));
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
    const users: Array<[id: number, email: string, username: string | null, locked?: number]> = [
      [1, "İlker@example.invalid", "first"],
      [2, "ascii@example.invalid", "ILKER"],
      [3, "dotless@example.invalid", "ılgaz"],
      [4, "sigma@example.invalid", "Σofia"],
      [5, "wild@example.invalid", "100%_real"],
      [6, "locked@example.invalid", "ilker-locked", 1],
      [7, "profile@example.invalid", null],
      [8, "other@example.invalid", "unrelated"],
      ...Array.from({ length: fillerCount }, (_, index): [number, string, string] => [
        100 + index,
        `filler${index}@example.invalid`,
        `filler${index}`,
      ]),
      [900, "late@example.invalid", "late-ılker"],
    ];
    const inserts = users.map(([id, email, username, locked = 0]) =>
      db
        .prepare('INSERT INTO "users" ("id", "uuid", "email", "username", "locked") VALUES (?, ?, ?, ?, ?)')
        .bind(id, `list-user-${id}`, email, username, locked)
    );
    for (let index = 0; index < inserts.length; index += 50) await db.batch(inserts.slice(index, index + 50));
    await db.batch([
      db.prepare(`INSERT INTO "Team" ("id", "name", "isOrganization") VALUES (1, 'Org', 1)`),
      db
        .prepare(
          `INSERT INTO "Profile" ("uid", "userId", "organizationId", "username", "updatedAt") VALUES ('profile-7', 7, 1, 'ilker-profile', ?)`
        )
        .bind("2026-11-06T00:00:00.000+00:00"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const list = (input: { searchTerm?: string; cursor?: number; limit?: number | null }) =>
    inD1(() => repository.listUsers({ limit: 10, ...input, cursor: input.cursor }));
  const ids = (result: Awaited<ReturnType<typeof list>>) => result.users.map(({ id }) => id);

  it("folds Unicode across email, username and profile usernames, including locked users", async () => {
    const result = await list({ searchTerm: " İLKER " });
    expect(ids(result)).toEqual([1, 2, 6, 7]);
    expect(result).toMatchObject({ total: 4, nextCursor: undefined });
    expect(result.users[3]).toMatchObject({ username: null, profiles: [{ username: "ilker-profile" }] });
    expect(result.users[2]).toMatchObject({ locked: true });
  });

  it("confirms candidates the SQL prefilter keeps, scanning past a full batch", async () => {
    const dotless = await list({ searchTerm: "ı" });
    expect(ids(dotless)).toEqual([3, 900]);
    expect(dotless.total).toBe(2);
    expect(ids(await list({ searchTerm: "σOFIA" }))).toEqual([4]);
  });

  it("keeps wildcard characters in a search as pattern syntax", async () => {
    expect(ids(await list({ searchTerm: "1%_R" }))).toEqual([5]);
    expect((await list({ searchTerm: "%" })).total).toBe(userCount);
  });

  it("pages matches with a total of every match", async () => {
    const first = await list({ searchTerm: "ilker", limit: 2 });
    expect(first).toMatchObject({ total: 4, nextCursor: 2 });
    expect(ids(first)).toEqual([1, 2]);

    const second = await list({ searchTerm: "ilker", limit: 2, cursor: 2 });
    expect(second).toMatchObject({ total: 4, nextCursor: undefined });
    expect(ids(second)).toEqual([6, 7]);
  });

  it("skips the first match after a cursor that does not match, and ends the list for a missing one", async () => {
    expect(ids(await list({ searchTerm: "ilker", cursor: 3 }))).toEqual([7]);
    expect(await list({ searchTerm: "ilker", cursor: 50 })).toMatchObject({ users: [], total: 4 });
    expect(ids(await list({ cursor: 50 }))).toEqual([]);
  });

  it("returns every match after the cursor without a limit", async () => {
    const result = await list({ searchTerm: "ilker", cursor: 1, limit: null });
    expect(ids(result)).toEqual([2, 6, 7]);
    expect(result.total).toBe(3);
  });

  it("keeps unsearched pages unchanged", async () => {
    const result = await list({ limit: 3 });
    expect(ids(result)).toEqual([1, 2, 3]);
    expect(result).toMatchObject({ total: userCount, nextCursor: 3 });
  });
});
