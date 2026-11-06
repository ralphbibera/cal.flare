import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { UserRepository } from "./UserRepository";

const oldVerified = "2026-01-01T00:00:00.000+00:00";
const newVerified = "2026-02-01T00:00:00.000+00:00";
const swap = {
  userId: 1,
  secondaryEmailId: 5,
  oldPrimaryEmail: "old@example.com",
  oldPrimaryEmailVerified: new Date(oldVerified),
  newPrimaryEmail: "new@example.com",
};

describe("swapPrimaryEmailWithSecondaryEmail on D1", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const repository = new UserRepository(prisma);
  const inD1 = <T>(callback: () => Promise<T>) => withD1Database({ DB: db }, callback);
  const emails = async () => ({
    primary: (await db.prepare('SELECT "email" FROM users WHERE "id" = 1').first())?.email,
    secondary: await db
      .prepare('SELECT "email", "emailVerified" FROM "SecondaryEmail" WHERE "id" = 5')
      .first(),
  });

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-email-swap-"));
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
  }, 60_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.batch([
      db.prepare('DELETE FROM "SecondaryEmail"'),
      db.prepare("DELETE FROM users"),
      db
        .prepare(`INSERT INTO users ("id", "uuid", "email", "emailVerified", "metadata", "allowSEOIndexing", "creationSource", "role")
        VALUES (1, 'user-1', 'old@example.com', ?, '{"currency":"usd"}', 0, 'webapp', 'ADMIN'),
        (2, 'user-2', 'taken@example.com', NULL, NULL, 1, NULL, 'USER')`)
        .bind(oldVerified),
      db
        .prepare(
          `INSERT INTO "SecondaryEmail" ("id", "userId", "email", "emailVerified") VALUES (5, 1, 'new@example.com', ?)`
        )
        .bind(newVerified),
    ]);
  });

  it("swaps the emails and returns the updated user as Prisma reads it", () =>
    inD1(async () => {
      const updated = await repository.swapPrimaryEmailWithSecondaryEmail(swap);

      expect(updated).toEqual(await prisma.user.findUniqueOrThrow({ where: { id: 1 } }));
      expect(updated).toMatchObject({
        email: "new@example.com",
        metadata: { currency: "usd" },
        allowSEOIndexing: false,
        creationSource: "WEBAPP",
      });
      expect(await emails()).toEqual({
        primary: "new@example.com",
        secondary: { email: "old@example.com", emailVerified: oldVerified },
      });
    }));

  it("keeps the secondary email when the later primary email update hits a unique email", () =>
    inD1(async () => {
      await expect(
        repository.swapPrimaryEmailWithSecondaryEmail({ ...swap, newPrimaryEmail: "taken@example.com" })
      ).rejects.toMatchObject({
        code: "P2002",
        meta: { modelName: "User", driverAdapterError: { cause: { constraint: { fields: ["email"] } } } },
      });

      expect(await emails()).toEqual({
        primary: "old@example.com",
        secondary: { email: "new@example.com", emailVerified: newVerified },
      });
    }));

  it("reports P2025 and keeps the primary email when the secondary email belongs to someone else", () =>
    inD1(async () => {
      await expect(
        repository.swapPrimaryEmailWithSecondaryEmail({ ...swap, userId: 2 })
      ).rejects.toMatchObject({
        code: "P2025",
        meta: { modelName: "SecondaryEmail" },
      });

      expect((await db.prepare('SELECT "email" FROM users WHERE "id" = 2').first())?.email).toBe(
        "taken@example.com"
      );
    }));

  it("lets simultaneous identical swaps both succeed with the swapped end state", () =>
    inD1(async () => {
      await Promise.all([
        repository.swapPrimaryEmailWithSecondaryEmail(swap),
        repository.swapPrimaryEmailWithSecondaryEmail(swap),
      ]);

      expect(await emails()).toEqual({
        primary: "new@example.com",
        secondary: { email: "old@example.com", emailVerified: oldVerified },
      });
    }));
});
