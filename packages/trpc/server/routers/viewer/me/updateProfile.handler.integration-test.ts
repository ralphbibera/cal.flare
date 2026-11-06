import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { updateProfileHandler } from "./updateProfile.handler";

const verified = "2026-01-01T00:00:00.000+00:00";
const user = {
  id: 1,
  email: "jane@example.com",
  emailVerified: new Date(verified),
  username: "jane",
  locale: "en",
  metadata: {},
  timeZone: "Europe/London",
  organizationId: null,
  movedToProfileId: null,
  defaultScheduleId: null,
} as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"];
const update = (secondaryEmails: { id: number; email: string; isDeleted: boolean }[]) =>
  updateProfileHandler({ ctx: { user }, input: { secondaryEmails } });

describe("updateProfile secondary email updates on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const secondaryEmails = async () =>
    (
      await db
        .prepare(
          'SELECT "id", "email", "emailVerified" FROM "SecondaryEmail" WHERE "userId" = 1 ORDER BY "id"'
        )
        .all()
    ).results;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-update-profile-"));
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
    await db
      .prepare(`INSERT INTO users ("id", "uuid", "email", "username")
        VALUES (1, 'user-1', 'jane@example.com', 'jane'), (2, 'user-2', 'john@example.com', 'john')`)
      .run();
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare('DELETE FROM "SecondaryEmail"'),
      db
        .prepare(`INSERT INTO "SecondaryEmail" ("id", "userId", "email", "emailVerified")
          VALUES (5, 1, 'first@example.com', ?), (6, 1, 'second@example.com', ?), (7, 2, 'taken@example.com', NULL)`)
        .bind(verified, verified),
    ]);
  });

  it("renames secondary emails and clears verification only for a changed address", () =>
    inD1(async () => {
      await expect(
        update([
          { id: 5, email: "renamed@example.com", isDeleted: false },
          { id: 6, email: "second@example.com", isDeleted: false },
        ])
      ).resolves.toMatchObject({ hasEmailBeenChanged: undefined, sendEmailVerification: false });

      expect(await secondaryEmails()).toEqual([
        { id: 5, email: "renamed@example.com", emailVerified: null },
        { id: 6, email: "second@example.com", emailVerified: verified },
      ]);
    }));

  it("keeps every secondary email when a later rename hits a unique email", () =>
    inD1(async () => {
      await expect(
        update([
          { id: 5, email: "renamed@example.com", isDeleted: false },
          { id: 6, email: "taken@example.com", isDeleted: false },
        ])
      ).rejects.toMatchObject({ code: "P2002", meta: { modelName: "SecondaryEmail" } });

      expect(await secondaryEmails()).toEqual([
        { id: 5, email: "first@example.com", emailVerified: verified },
        { id: 6, email: "second@example.com", emailVerified: verified },
      ]);
    }));

  it("lets simultaneous identical renames both succeed", () =>
    inD1(async () => {
      const renames = [{ id: 5, email: "renamed@example.com", isDeleted: false }];

      await Promise.all([update(renames), update(renames)]);

      expect(await secondaryEmails()).toEqual([
        { id: 5, email: "renamed@example.com", emailVerified: null },
        { id: 6, email: "second@example.com", emailVerified: verified },
      ]);
    }));
});
