import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { findUserIdByInsensitiveField } from "./findUserIdByInsensitiveField";

describe("findUserIdByInsensitiveField", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-auth-insensitive-"));
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
    await db.batch(
      [
        [1, "Ada@Example.invalid", "GOOGLE", "Provider-İD"],
        [2, "ÉLODIE@example.invalid", "GOOGLE", "other"],
        [3, "a_b@example.invalid", "CAL", null],
        [4, "axb@example.invalid", "SAML", "provider-id"],
        [5, "kelvinK@example.invalid", "CAL", null],
      ].map(([id, email, identityProvider, identityProviderId]) =>
        db
          .prepare(
            'INSERT INTO "users" ("id", "uuid", "email", "identityProvider", "identityProviderId") VALUES (?, ?, ?, ?, ?)'
          )
          .bind(id, `lookup-${id}`, email, identityProvider, identityProviderId)
      )
    );
  }, 30_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const lookup = (options: Parameters<typeof findUserIdByInsensitiveField>[0]) =>
    withD1Database({ DB: db }, () => findUserIdByInsensitiveField(options));

  it("matches the whole value, not a substring", async () => {
    await expect(lookup({ field: "email", value: "ADA@EXAMPLE.INVALID" })).resolves.toBe(1);
    await expect(lookup({ field: "email", value: "ada@example" })).resolves.toBeNull();
  });

  it("folds non-ASCII characters SQLite LIKE would miss", async () => {
    await expect(lookup({ field: "email", value: "élodie@EXAMPLE.invalid" })).resolves.toBe(2);
    await expect(lookup({ field: "email", value: "KELVINK@example.invalid" })).resolves.toBe(5);
  });

  it("keeps PostgreSQL's treatment of underscore as a wildcard, returning the lowest id", async () => {
    await expect(lookup({ field: "email", value: "axb@example.invalid" })).resolves.toBe(4);
    await expect(lookup({ field: "email", value: "a_b@example.invalid" })).resolves.toBe(3);
  });

  it("stays within the identity provider scope", async () => {
    await expect(
      lookup({ where: { identityProvider: "SAML" }, field: "identityProviderId", value: "OTHER" })
    ).resolves.toBeNull();
    await expect(
      lookup({ where: { identityProvider: "GOOGLE" }, field: "identityProviderId", value: "OTHER" })
    ).resolves.toBe(2);
    await expect(
      lookup({ where: { identityProvider: "SAML" }, field: "identityProviderId", value: "PROVIDER-ID" })
    ).resolves.toBe(4);
    await expect(
      lookup({ where: { identityProvider: "GOOGLE" }, field: "identityProviderId", value: "PROVIDER-ID" })
    ).resolves.toBe(1);
  });
});
