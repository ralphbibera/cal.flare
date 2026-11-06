import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { D1PaymentCredentialRepository } from "./D1PaymentCredentialRepository";

describe("booking payment credentials", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-payment-credentials-"));
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
      db
        .prepare(
          'INSERT INTO "users" ("id", "uuid", "email") VALUES (1, \'payment-user-1\', ?), (2, \'payment-user-2\', ?)'
        )
        .bind("owner@example.invalid", "other@example.invalid"),
      ...[
        ["pay", '["payment","calendar","payment"]', 0],
        ["calendar", '["calendar"]', 1],
        ["absent", null, 1],
      ].map(([slug, categories, enabled]) =>
        db
          .prepare(
            'INSERT INTO "App" ("slug", "dirName", "categories", "enabled", "updatedAt") VALUES (?, ?, ?, ?, ?)'
          )
          .bind(slug, slug, categories, enabled, "2026-11-05T00:00:00.000+00:00")
      ),
      ...[
        [1, "pay", 1, 1],
        [2, "pay", 2, 0],
        [3, "calendar", 1, 0],
        [4, "absent", 1, 0],
        [5, null, 1, 0],
      ].map(([id, appId, userId, invalid]) =>
        db
          .prepare(
            'INSERT INTO "Credential" ("id", "type", "key", "appId", "userId", "invalid") VALUES (?, ?, ?, ?, ?, ?)'
          )
          .bind(id, "payment", JSON.stringify({ token: `synthetic-${id}` }), appId, userId, invalid)
      ),
    ]);
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("retains owner scope, original fields, duplicate categories and disabled/invalid payment installs", async () => {
    expect(
      await withD1Database({ DB: db }, () => D1PaymentCredentialRepository.findForBooking({ userId: 1 }))
    ).toEqual([
      {
        key: { token: "synthetic-1" },
        appId: "pay",
        app: { categories: ["payment", "calendar", "payment"], dirName: "pay" },
      },
    ]);
  });

  it("uses explicit credential id instead of user scope, matching the booking contract", async () => {
    expect(
      await withD1Database({ DB: db }, () =>
        D1PaymentCredentialRepository.findForBooking({ userId: 1, credentialId: 2 })
      )
    ).toEqual([
      {
        key: { token: "synthetic-2" },
        appId: "pay",
        app: { categories: ["payment", "calendar", "payment"], dirName: "pay" },
      },
    ]);
    expect(
      await withD1Database({ DB: db }, () =>
        D1PaymentCredentialRepository.findForBooking({ userId: 1, credentialId: 999 })
      )
    ).toEqual([]);
  });

  it("retains the zero-id fallback and excludes non-payment and absent app relations", async () => {
    expect(
      await withD1Database({ DB: db }, () =>
        D1PaymentCredentialRepository.findForBooking({ userId: 1, credentialId: 0 })
      )
    ).toHaveLength(1);
    for (const credentialId of [3, 4, 5]) {
      expect(
        await withD1Database({ DB: db }, () =>
          D1PaymentCredentialRepository.findForBooking({ userId: 1, credentialId })
        )
      ).toEqual([]);
    }
  });
  it("does not mix category membership and credentials across a concurrent committed change", async () => {
    await db.prepare('UPDATE "Credential" SET "key" = ? WHERE "id" = 1').bind('{"token":"before"}').run();
    const [credentials] = await Promise.all([
      withD1Database({ DB: db }, () => D1PaymentCredentialRepository.findForBooking({ userId: 1 })),
      db.batch([
        db.prepare('UPDATE "App" SET "categories" = ? WHERE "slug" = ?').bind('["calendar"]', "pay"),
        db.prepare('UPDATE "Credential" SET "key" = ? WHERE "id" = 1').bind('{"token":"after"}'),
      ]),
    ]);
    expect(
      credentials.length === 0 ||
        credentials.every(
          ({ key, app }) => JSON.stringify(key) === '{"token":"before"}' && app.categories.includes("payment")
        )
    ).toBe(true);
    expect(
      await withD1Database({ DB: db }, () => D1PaymentCredentialRepository.findForBooking({ userId: 1 }))
    ).toEqual([]);
  });
});
