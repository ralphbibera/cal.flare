import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mts";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { ProfileRepository } from "./ProfileRepository";

const organizationId = 10;
const orgAutoAcceptEmail = "example.com";
const member = (id: number, username: string | null, email = `user${id}@example.com`) => ({
  id,
  username,
  email,
});

describe("ProfileRepository createMany on D1", () => {
  let root: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const profiles = async () => {
    const { results } = await db
      .prepare(
        'SELECT "uid", "userId", "organizationId", "username", "createdAt", "updatedAt" FROM "Profile" ORDER BY "id"'
      )
      .all<{
        uid: string;
        userId: number;
        organizationId: number;
        username: string;
        createdAt: string;
        updatedAt: string;
      }>();
    return results;
  };

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "profile-create-many-"));
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
    await db.prepare("INSERT INTO Team (id, name) VALUES (?, ?)").bind(organizationId, "Org").run();
    for (const id of [1, 2, 3, 4]) {
      await db
        .prepare("INSERT INTO users (id, uuid, email) VALUES (?, ?, ?)")
        .bind(id, `user-${id}`, `user${id}@example.com`)
        .run();
    }
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (root) await rm(root, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.prepare('UPDATE users SET "movedToProfileId" = NULL').run();
    await db.prepare('DELETE FROM "Profile"').run();
  });

  it.each([
    [
      "createMany",
      (input: Parameters<typeof ProfileRepository.createMany>[0]) => ProfileRepository.createMany(input),
    ],
    [
      "createManyPromise",
      (input: Parameters<typeof ProfileRepository.createManyPromise>[0]) =>
        ProfileRepository.createManyPromise(input),
    ],
  ])("%s writes generated UIDs, username fallbacks and schema defaults", async (_name, create) =>
    withD1Database({ DB: db }, async () => {
      await expect(
        create({
          users: [member(1, "alice"), member(2, null), member(3, "", "carol@other.com")],
          organizationId,
          orgAutoAcceptEmail,
        })
      ).resolves.toEqual({ count: 3 });

      const rows = await profiles();
      expect(rows.map(({ userId, organizationId, username }) => [userId, organizationId, username])).toEqual([
        [1, organizationId, "alice"],
        [2, organizationId, "user2"],
        [3, organizationId, "carol-other"],
      ]);
      expect(new Set(rows.map(({ uid }) => uid)).size).toBe(3);
      for (const { createdAt, updatedAt } of rows) {
        expect(createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
        expect(updatedAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
      }
    }));

  it("skips conflicts on both compound unique keys and counts only inserted rows", async () =>
    withD1Database({ DB: db }, async () => {
      await ProfileRepository.createMany({ users: [member(1, "alice")], organizationId, orgAutoAcceptEmail });
      const [existing] = await profiles();

      await expect(
        ProfileRepository.createMany({
          users: [member(1, "renamed"), member(2, "alice"), member(3, "carol"), member(4, "carol")],
          organizationId,
          orgAutoAcceptEmail,
        })
      ).resolves.toEqual({ count: 1 });

      const rows = await profiles();
      expect(rows.map(({ userId, username }) => [userId, username])).toEqual([
        [1, "alice"],
        [3, "carol"],
      ]);
      expect(rows[0]).toEqual(existing);
    }));

  it("returns a zero count without writing for empty input", async () =>
    withD1Database({ DB: db }, async () => {
      await expect(
        ProfileRepository.createMany({ users: [], organizationId, orgAutoAcceptEmail })
      ).resolves.toEqual({ count: 0 });
      await expect(
        ProfileRepository.createManyPromise({ users: [], organizationId, orgAutoAcceptEmail })
      ).resolves.toEqual({ count: 0 });
      expect(await profiles()).toEqual([]);
    }));

  it("rolls back earlier rows and reports P2003 when a later row breaks a foreign key", async () =>
    withD1Database({ DB: db }, async () => {
      await expect(
        ProfileRepository.createMany({
          users: [member(1, "alice"), member(404, "ghost")],
          organizationId,
          orgAutoAcceptEmail,
        })
      ).rejects.toMatchObject({ code: "P2003", meta: { modelName: "Profile" } });
      expect(await profiles()).toEqual([]);
    }));

  it("rolls back earlier rows and reports P2011 when a later row breaks NOT NULL", async () =>
    withD1Database({ DB: db }, async () => {
      await expect(
        ProfileRepository.createManyPromise({
          users: [
            member(1, "alice"),
            { id: null as unknown as number, username: "ghost", email: "ghost@example.com" },
          ],
          organizationId,
          orgAutoAcceptEmail,
        })
      ).rejects.toMatchObject({ code: "P2011", meta: { modelName: "Profile" } });
      expect(await profiles()).toEqual([]);
    }));

  it("createManyForExistingUsers links new and existing profiles and resolves to undefined", async () =>
    withD1Database({ DB: db }, async () => {
      await ProfileRepository.createMany({ users: [member(1, "alice")], organizationId, orgAutoAcceptEmail });

      await expect(
        ProfileRepository.createManyForExistingUsers({
          users: [member(1, "ignored"), member(2, "bob")],
          organizationId,
          orgAutoAcceptEmail,
        })
      ).resolves.toBeUndefined();

      const { results } = await db
        .prepare(
          `SELECT u."id" AS "userId", u."movedToProfileId", p."id" AS "profileId", p."username"
          FROM users u JOIN "Profile" p ON p."userId" = u."id" ORDER BY u."id"`
        )
        .all<{ userId: number; movedToProfileId: number; profileId: number; username: string }>();
      expect(results.map(({ userId, username }) => [userId, username])).toEqual([
        [1, "alice"],
        [2, "bob"],
      ]);
      for (const { movedToProfileId, profileId } of results) expect(movedToProfileId).toBe(profileId);
    }));
});
