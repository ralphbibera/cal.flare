import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { UserRepository } from "./UserRepository";

describe("findManyByEmailsWithEmailVerificationSettings", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const repository = new UserRepository(prisma);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-user-email-verification-"));
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
    const verified = "2026-11-05T00:00:00.000+00:00";
    await db.batch([
      ...[
        [1, "primary@example.invalid", verified, 0, 1],
        [2, "unverified@example.invalid", null, 0, 1],
        [3, "locked@example.invalid", verified, 1, 1],
        [4, "owner@example.invalid", null, 0, 0],
        [5, "Case@example.invalid", verified, 0, 1],
        [6, "dup@example.invalid", verified, 0, 0],
      ].map(([id, email, emailVerified, locked, requiresBookerEmailVerification]) =>
        db
          .prepare(
            'INSERT INTO "users" ("id", "uuid", "email", "emailVerified", "locked", "requiresBookerEmailVerification") VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind(id, `email-user-${id}`, email, emailVerified, locked, requiresBookerEmailVerification)
      ),
      ...[
        [1, 4, "alias@example.invalid", verified],
        [2, 4, "alias-unverified@example.invalid", null],
        [3, 3, "locked-alias@example.invalid", verified],
        [4, 6, "dup@example.invalid", verified],
      ].map(([id, userId, email, emailVerified]) =>
        db
          .prepare(
            'INSERT INTO "SecondaryEmail" ("id", "userId", "email", "emailVerified") VALUES (?, ?, ?, ?)'
          )
          .bind(id, userId, email, emailVerified)
      ),
    ]);
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("matches verified, unlocked primary and secondary emails case-sensitively past D1's bind limit", async () => {
    const fillers = Array.from({ length: 60 }, (_, index) => `filler-${index}@example.invalid`);
    const users = await withD1Database({ DB: db }, () =>
      repository.findManyByEmailsWithEmailVerificationSettings({
        emails: [
          ...fillers,
          "primary@example.invalid",
          "unverified@example.invalid",
          "locked@example.invalid",
          "locked-alias@example.invalid",
          "owner@example.invalid",
          "alias@example.invalid",
          "alias-unverified@example.invalid",
          "case@example.invalid",
          "dup@example.invalid",
        ],
      })
    );

    expect([...users].sort((a, b) => a.matchedEmail.localeCompare(b.matchedEmail))).toEqual([
      {
        email: "owner@example.invalid",
        matchedEmail: "alias@example.invalid",
        requiresBookerEmailVerification: false,
      },
      {
        email: "dup@example.invalid",
        matchedEmail: "dup@example.invalid",
        requiresBookerEmailVerification: false,
      },
      {
        email: "primary@example.invalid",
        matchedEmail: "primary@example.invalid",
        requiresBookerEmailVerification: true,
      },
    ]);
  });
});
