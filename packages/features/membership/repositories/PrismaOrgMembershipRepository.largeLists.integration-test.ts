import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaOrgMembershipRepository } from "./PrismaOrgMembershipRepository";

const ORG_COUNT = 250;

describe("PrismaOrgMembershipRepository over a long org list on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const orgIds = Array.from({ length: ORG_COUNT }, (_, index) => index + 1);
  const childTeamId = ORG_COUNT + 1;
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-org-membership-large-lists-"));
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
      ...[1, 2, 3].map((id) =>
        db
          .prepare('INSERT INTO "users" ("id", "uuid", "email") VALUES (?, ?, ?)')
          .bind(id, `org-member-${id}`, `org-member-${id}@example.invalid`)
      ),
      ...orgIds.map((id) =>
        db.prepare('INSERT INTO "Team" ("id", "name") VALUES (?, ?)').bind(id, `Org ${id}`)
      ),
      db
        .prepare('INSERT INTO "Team" ("id", "name", "parentId") VALUES (?, ?, ?)')
        .bind(childTeamId, "Child team", ORG_COUNT),
      ...orgIds.map((id) =>
        db
          .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, 1, 1, ?)')
          .bind(id, "ADMIN")
      ),
      db
        .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, 2, 1, ?)')
        .bind(ORG_COUNT, "MEMBER"),
      db
        .prepare('INSERT INTO "Membership" ("teamId", "userId", "accepted", "role") VALUES (?, 3, 1, ?)')
        .bind(childTeamId, "MEMBER"),
    ]);
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("matches an org host inside a long admin org list", async () => {
    await expect(
      inD1(() => PrismaOrgMembershipRepository.isLoggedInUserOrgAdminOfBookingHost(1, 2))
    ).resolves.toBe(true);
  });

  it("matches a child team host by the long parent org list", async () => {
    await expect(
      inD1(() => PrismaOrgMembershipRepository.isLoggedInUserOrgAdminOfBookingHost(1, 3))
    ).resolves.toBe(true);
  });
});
