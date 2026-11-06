import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createCallerFactory } from "../../../trpc";
import { userAdminRouter } from "./_router";

vi.mock("@calcom/features/auth/lib/userFromSessionUtils", () => ({
  getUserSession: async () => ({ user: { id: 99, role: "ADMIN" }, session: {} }),
}));

const caller = createCallerFactory(userAdminRouter)({ prisma } as unknown as Parameters<
  ReturnType<typeof createCallerFactory<typeof userAdminRouter>>
>[0]);
// The requested user's id travels in the raw input beside the parsed update fields.
const update = (input: { userId: number; username?: string; name?: string }) =>
  caller.update(input as Parameters<typeof caller.update>[0]);

describe("admin user update on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const usernames = async (userId: number) => ({
    user: (await db.prepare('SELECT "username" FROM users WHERE "id" = ?').bind(userId).first())?.username,
    profiles: (
      await db.prepare('SELECT "username" FROM "Profile" WHERE "userId" = ? ORDER BY "id"').bind(userId).all()
    ).results.map((row) => row.username),
    redirect: (await db.prepare('SELECT "toUrl" FROM "TempOrgRedirect" WHERE "id" = 1').first())?.toUrl,
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-admin-user-update-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../../../apps/web/cloudflare.config")).default;
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
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare('DROP TRIGGER IF EXISTS "fail_redirect"'),
      db.prepare('DELETE FROM "TempOrgRedirect"'),
      db.prepare('UPDATE users SET "movedToProfileId" = NULL'),
      db.prepare('DELETE FROM "Profile"'),
      db.prepare("DELETE FROM users"),
      db.prepare('DELETE FROM "Team"'),
      db.prepare(
        `INSERT INTO "Team" ("id", "name", "slug", "isOrganization") VALUES (10, 'Org', 'org', 1), (11, 'Bare', NULL, 1)`
      ),
      db.prepare(`INSERT INTO users ("id", "uuid", "email", "username", "name")
        VALUES (1, 'u-1', 'moved@example.com', 'old', 'Moved'), (2, 'u-2', 'plain@example.com', 'plain', 'Plain'),
        (3, 'u-3', 'bare@example.com', 'bare', 'Bare')`),
      db
        .prepare(`INSERT INTO "Profile" ("id", "uid", "userId", "organizationId", "username", "updatedAt")
        VALUES (100, 'p-100', 1, 10, 'old', ?), (200, 'p-200', 2, 10, 'plain', ?), (300, 'p-300', 3, 11, 'bare', ?),
        (400, 'p-400', 3, 10, 'taken', ?)`)
        .bind(...Array(4).fill("2026-01-01T00:00:00.000+00:00")),
      db.prepare('UPDATE users SET "movedToProfileId" = "id" * 100 WHERE "id" IN (1, 3)'),
      db.prepare(`INSERT INTO "TempOrgRedirect" ("id", "from", "fromOrgId", "type", "toUrl", "updatedAt")
        VALUES (1, 'old', 0, 'user', 'https://old.example', '2026-01-01T00:00:00.000+00:00')`),
    ]);
  });

  it("renames a moved user's profile, repoints redirects and returns the updated user", () =>
    inD1(async () => {
      const result = await update({ userId: 1, username: "new", name: "Renamed" });

      expect(result).toEqual({
        user: await prisma.user.findUniqueOrThrow({ where: { id: 1 } }),
        message: "User with id: 1 updated successfully",
      });
      expect(result.user).toMatchObject({ username: "new", name: "Renamed" });
      expect(await usernames(1)).toEqual({ user: "new", profiles: ["new"], redirect: `${WEBAPP_URL}/new` });
    }));

  it("renames every profile of a user that was never moved", () =>
    inD1(async () => {
      await update({ userId: 2, username: "plainer" });

      expect(await usernames(2)).toMatchObject({ user: "plainer", profiles: ["plainer"] });
    }));

  it("keeps the user and profile when the last redirect update fails", () =>
    inD1(async () => {
      await db
        .prepare(`CREATE TRIGGER "fail_redirect" BEFORE UPDATE ON "TempOrgRedirect"
          BEGIN SELECT RAISE(ABORT, 'forced late failure'); END`)
        .run();

      await expect(update({ userId: 1, username: "new" })).rejects.toThrow(/forced late failure/);

      expect(await usernames(1)).toEqual({ user: "old", profiles: ["old"], redirect: "https://old.example" });
    }));

  it("keeps the user when the moved profile's organization has no slug", () =>
    inD1(async () => {
      await expect(update({ userId: 3, username: "renamed", name: "X" })).rejects.toThrow(
        "Team has no attached slug."
      );

      expect(await usernames(3)).toMatchObject({ user: "bare", profiles: ["bare", "taken"] });
    }));

  it("keeps the user when a later profile rename hits a unique username", () =>
    inD1(async () => {
      await expect(update({ userId: 2, username: "taken" })).rejects.toMatchObject({
        cause: { code: "P2002" },
      });

      expect(await usernames(2)).toMatchObject({ user: "plain", profiles: ["plain"] });
    }));

  it("keeps each user's username and moved profile in step under simultaneous updates", () =>
    inD1(async () => {
      await Promise.all([
        update({ userId: 1, username: "first" }),
        update({ userId: 1, username: "second" }),
      ]);

      const { user, profiles } = await usernames(1);
      expect(["first", "second"]).toContain(user);
      expect(profiles).toEqual([user]);
    }));
});
