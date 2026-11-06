import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createOrUpdateMemberships } from "./createOrUpdateMemberships";
import { joinAnyChildTeamOnOrgInvite } from "./organization";

const d1DateTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/;
const orgId = 10;
const subTeamId = 11;
const otherSubTeamId = 12;
const userId = 1;
const orgSettings = { orgAutoAcceptEmail: "example.com" };
const subTeam = {
  id: subTeamId,
  parentId: orgId,
  isOrganization: false,
  parent: { id: orgId, organizationSettings: orgSettings },
};
const org = {
  id: orgId,
  organizationSettings: { orgAutoAcceptEmail: "example.com" } as Parameters<
    typeof joinAnyChildTeamOnOrgInvite
  >[0]["org"]["organizationSettings"],
};

describe("signup membership writes on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  const snapshot = async () => ({
    profiles: (
      await db.prepare('SELECT "userId", "organizationId", "username" FROM "Profile" ORDER BY "id"').all()
    ).results,
    memberships: (
      await db
        .prepare('SELECT "userId", "teamId", "role", "accepted" FROM "Membership" ORDER BY "teamId"')
        .all()
    ).results,
    organizationId: (await db.prepare('SELECT "organizationId" FROM users WHERE id = ?').bind(userId).first())
      ?.organizationId,
  });
  const failWritesTo = (event: "INSERT" | "UPDATE", teamId: number) =>
    db
      .prepare(
        `CREATE TRIGGER "fail_membership" BEFORE ${event} ON "Membership" WHEN NEW."teamId" = ${teamId}
         BEGIN SELECT RAISE(ABORT, 'forced late failure'); END`
      )
      .run();

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-signup-memberships-"));
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
    await db.batch([
      db.prepare(`INSERT INTO "Team" ("id", "name", "slug", "isOrganization", "parentId")
        VALUES (10, 'Org', 'org', 1, NULL), (11, 'Sub', 'sub', 0, 10), (12, 'Other', 'other', 0, 10)`),
      db.prepare(
        `INSERT INTO users ("id", "uuid", "email", "username") VALUES (1, 'user-1', 'jane@example.com', NULL)`
      ),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare('DROP TRIGGER IF EXISTS "fail_membership"'),
      db.prepare('DELETE FROM "Profile"'),
      db.prepare('DELETE FROM "Membership"'),
      db.prepare('UPDATE users SET "organizationId" = NULL'),
    ]);
  });

  describe("createOrUpdateMemberships", () => {
    it("creates the org profile and accepted memberships and returns the team membership", () =>
      withD1Database({ DB: db }, async () => {
        const result = await createOrUpdateMemberships({ user: { id: userId }, team: subTeam });

        expect(result).toEqual({
          membership: {
            id: expect.any(Number),
            teamId: subTeamId,
            userId,
            accepted: true,
            role: "MEMBER",
            customRoleId: null,
            createdAt: expect.any(Date),
            updatedAt: expect.any(Date),
          },
          orgMembership: null,
        });
        expect(await snapshot()).toMatchObject({
          profiles: [{ userId, organizationId: orgId, username: "jane" }],
          memberships: [
            { userId, teamId: orgId, role: "MEMBER", accepted: 1 },
            { userId, teamId: subTeamId, role: "MEMBER", accepted: 1 },
          ],
        });
        const row = await db.prepare('SELECT "createdAt", "updatedAt" FROM "Membership" LIMIT 1').first();
        expect(row).toEqual({
          createdAt: expect.stringMatching(d1DateTime),
          updatedAt: expect.stringMatching(d1DateTime),
        });
      }));

    it("accepts an existing pending membership", () =>
      withD1Database({ DB: db }, async () => {
        await db
          .prepare(
            `INSERT INTO "Membership" ("userId", "teamId", "role", "accepted") VALUES (1, 11, 'ADMIN', 0)`
          )
          .run();

        const { membership } = await createOrUpdateMemberships({ user: { id: userId }, team: subTeam });

        expect(membership).toMatchObject({ teamId: subTeamId, role: "ADMIN", accepted: true });
      }));

    it("leaves no profile or membership when the last membership write fails", () =>
      withD1Database({ DB: db }, async () => {
        await failWritesTo("INSERT", orgId);

        await expect(createOrUpdateMemberships({ user: { id: userId }, team: subTeam })).rejects.toThrow(
          /forced late failure/
        );

        expect(await snapshot()).toMatchObject({ profiles: [], memberships: [] });
      }));

    it("lets simultaneous signups for the same invite both succeed with one row each", () =>
      withD1Database({ DB: db }, async () => {
        const results = await Promise.all([
          createOrUpdateMemberships({ user: { id: userId }, team: subTeam }),
          createOrUpdateMemberships({ user: { id: userId }, team: subTeam }),
        ]);

        expect(results[0].membership.id).toBe(results[1].membership.id);
        expect(await snapshot()).toMatchObject({
          profiles: [{ userId, organizationId: orgId }],
          memberships: [{ teamId: orgId }, { teamId: subTeamId }],
        });
      }));
  });

  describe("joinAnyChildTeamOnOrgInvite", () => {
    const pendingMemberships = () =>
      db
        .prepare(`INSERT INTO "Membership" ("userId", "teamId", "role", "accepted")
          VALUES (1, 10, 'MEMBER', 0), (1, 11, 'MEMBER', 0), (1, 12, 'MEMBER', 0)`)
        .run();

    it("moves the user into the org and accepts org and child team invites", () =>
      withD1Database({ DB: db }, async () => {
        await pendingMemberships();

        await expect(joinAnyChildTeamOnOrgInvite({ userId, org })).resolves.toBeUndefined();

        expect(await snapshot()).toMatchObject({
          organizationId: orgId,
          profiles: [{ userId, organizationId: orgId, username: "jane" }],
          memberships: [{ accepted: 1 }, { accepted: 1 }, { accepted: 1 }],
        });
      }));

    it("leaves the user, profile and invites untouched when the last invite update fails", () =>
      withD1Database({ DB: db }, async () => {
        await pendingMemberships();
        await failWritesTo("UPDATE", otherSubTeamId);

        await expect(joinAnyChildTeamOnOrgInvite({ userId, org })).rejects.toThrow(/forced late failure/);

        expect(await snapshot()).toMatchObject({
          organizationId: null,
          profiles: [],
          memberships: [{ accepted: 0 }, { accepted: 0 }, { accepted: 0 }],
        });
      }));

    it("lets simultaneous joins both succeed with one profile", () =>
      withD1Database({ DB: db }, async () => {
        await pendingMemberships();

        await Promise.all([
          joinAnyChildTeamOnOrgInvite({ userId, org }),
          joinAnyChildTeamOnOrgInvite({ userId, org }),
        ]);

        expect(await snapshot()).toMatchObject({
          organizationId: orgId,
          profiles: [{ userId, organizationId: orgId }],
          memberships: [{ accepted: 1 }, { accepted: 1 }, { accepted: 1 }],
        });
      }));
  });
});
