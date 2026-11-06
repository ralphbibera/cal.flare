import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ProfileRepository } from "./ProfileRepository";

const COUNT = 250;
const organizationId = 1;

describe("ProfileRepository reads and writes over long id lists on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const ids = Array.from({ length: COUNT }, (_, index) => index + 1);
  const usernames = ids.map((id) => `user-${id}`);
  const member = (id: number) => ({ id, username: `user-${id}`, email: `user${id}@example.com` });
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const profileCount = async (organization: number) => {
    const { results } = await db
      .prepare('SELECT COUNT(*) AS "count" FROM "Profile" WHERE "organizationId" = ?')
      .bind(organization)
      .all<{ count: number }>();
    return results[0].count;
  };

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-profile-large-lists-"));
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
      ...ids.map((id) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email", "username") VALUES (?, ?, ?, ?)')
          .bind(id, `profile-user-${id}`, `user${id}@example.com`, `user-${id}`)
      ),
      db
        .prepare('INSERT INTO "Team" ("id", "name", "slug") VALUES (?, ?, ?)')
        .bind(organizationId, "Org One", "org-one"),
      ...[2, 3].map((id) =>
        db
          .prepare('INSERT INTO "Team" ("id", "name", "slug") VALUES (?, ?, ?)')
          .bind(id, `Org ${id}`, `org-${id}`)
      ),
      ...ids.map((id) =>
        db
          .prepare(
            'INSERT INTO "Profile" ("uid", "userId", "organizationId", "username", "updatedAt") VALUES (?, ?, ?, ?, ?)'
          )
          .bind(`profile-${id}`, id, organizationId, `user-${id}`, "2026-01-01T00:00:00.000+00:00")
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("finds profiles for a long user id list", async () => {
    const profiles = await inD1(() => ProfileRepository.findManyForUsers(ids));
    expect(profiles.map(({ userId }) => userId).sort((left, right) => left - right)).toEqual(ids);
  });

  it("finds profiles by a long username list", async () => {
    const profiles = await inD1(() =>
      ProfileRepository.findManyByOrgSlugOrRequestedSlug({ usernames, orgSlug: "org-one" })
    );
    expect(profiles).toHaveLength(COUNT);
    expect(new Set(profiles.map(({ username }) => username))).toEqual(new Set(usernames));
  });

  it("deletes every profile for a long user id list atomically", async () => {
    await db
      .prepare(
        `CREATE TRIGGER fail_profile_delete BEFORE DELETE ON "Profile"
         WHEN OLD."userId" = 200
         BEGIN SELECT RAISE(ABORT, 'forced profile delete failure'); END`
      )
      .run();
    await expect(inD1(() => ProfileRepository.deleteMany({ userIds: ids, organizationId }))).rejects.toThrow(
      /forced profile delete failure/
    );
    expect(await profileCount(organizationId)).toBe(COUNT);
    await db.prepare("DROP TRIGGER fail_profile_delete").run();

    const result = await inD1(() => ProfileRepository.deleteMany({ userIds: ids, organizationId }));
    expect(result).toEqual({ count: COUNT });
    expect(await profileCount(organizationId)).toBe(0);
  });

  it("creates profiles and links movedToProfile for a long user id list", async () => {
    await inD1(() =>
      ProfileRepository.createManyForExistingUsers({
        users: ids.map(member),
        organizationId: 2,
        orgAutoAcceptEmail: "example.com",
      })
    );

    const { results } = await db
      .prepare(
        `SELECT u."id" AS "userId", u."movedToProfileId", p."id" AS "profileId"
         FROM "users" u JOIN "Profile" p ON p."userId" = u."id" AND p."organizationId" = 2 ORDER BY u."id"`
      )
      .all<{ userId: number; movedToProfileId: number; profileId: number }>();
    expect(results.map(({ userId }) => userId)).toEqual(ids);
    for (const { movedToProfileId, profileId } of results) expect(movedToProfileId).toBe(profileId);
  });

  it("leaves no partial write when a later profile insert fails", async () => {
    await db
      .prepare(
        `CREATE TRIGGER fail_profile_insert BEFORE INSERT ON "Profile"
         WHEN NEW."userId" = 200
         BEGIN SELECT RAISE(ABORT, 'forced profile insert failure'); END`
      )
      .run();

    await expect(
      inD1(() =>
        ProfileRepository.createManyForExistingUsers({
          users: ids.map(member),
          organizationId: 3,
          orgAutoAcceptEmail: "example.com",
        })
      )
    ).rejects.toThrow(/forced profile insert failure/);
    expect(await profileCount(3)).toBe(0);

    await db.prepare("DROP TRIGGER fail_profile_insert").run();
  });
});
