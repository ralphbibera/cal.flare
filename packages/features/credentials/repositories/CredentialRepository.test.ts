import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { CredentialRepository } from "./CredentialRepository";

describe("credentials by stored JSON property", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  const repository = new CredentialRepository(prisma);

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-credential-properties-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
    runtime = new Miniflare({
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
    db = await runtime.getD1Database("DB");
    await db.batch(
      ["salesforce", "other"].map((slug) =>
        db
          .prepare('INSERT INTO "App" ("slug", "dirName", "updatedAt") VALUES (?, ?, ?)')
          .bind(slug, slug, "2026-11-05T00:00:00.000+00:00")
      )
    );
  }, 30_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  beforeEach(async () => {
    await db.prepare('DELETE FROM "Credential"').run();
  });

  const insert = (id: number, key: unknown, appId = "salesforce") =>
    db
      .prepare('INSERT INTO "Credential" ("id", "type", "key", "appId") VALUES (?, ?, ?, ?)')
      .bind(id, "salesforce", JSON.stringify(key), appId)
      .run();

  it.each([
    "instance_url",
    "with.dot",
    "with[0]",
    'with"quote',
    "with\\slash",
    'dot."and[0]\\',
    "",
    "日本語",
    "line\nbreak",
  ])("matches the literal property %j without returning credential secrets", async (property) => {
    await insert(1, { [property]: { value: "match" }, token: "synthetic-secret" });
    const credential = await withD1Database({ DB: db }, () =>
      repository.findByAppIdAndKeyValue({
        appId: "salesforce",
        keyPath: [property, "value"],
        value: "match",
      })
    );
    expect(credential).toMatchObject({ id: 1, integrationAttributeSyncs: [] });
    expect(credential).not.toHaveProperty("key");
    expect(credential).not.toHaveProperty("encryptedKey");
  });

  it("preserves app scope and Salesforce's requested key projection", async () => {
    await insert(1, { instance_url: "https://crm.example.invalid", id: "other-id" }, "other");
    await insert(2, {
      instance_url: "https://crm.example.invalid",
      id: "salesforce-id",
      access_token: "synthetic-secret",
    });
    const credential = await withD1Database({ DB: db }, () =>
      repository.findByAppIdAndKeyValue({
        appId: "salesforce",
        keyPath: ["instance_url"],
        value: "https://crm.example.invalid",
        keyFields: ["id"],
      })
    );
    expect(credential).toMatchObject({ id: 2, key: { id: "salesforce-id" } });
    expect(credential?.key).toEqual({ id: "salesforce-id" });
    expect(JSON.stringify(credential)).not.toContain("synthetic-secret");
  });

  it("distinguishes booleans from strings, null and missing properties", async () => {
    const values = [
      null,
      {},
      { enabled: null },
      { enabled: "true" },
      { enabled: 1 },
      { enabled: true },
      { enabled: false },
      { enabled: "false" },
    ];
    for (const [index, value] of values.entries()) await insert(index + 1, value);
    for (const [value, id] of [
      [true, 6],
      [false, 7],
      ["true", 4],
      ["false", 8],
    ] as const) {
      expect(
        await withD1Database({ DB: db }, () =>
          repository.findByAppIdAndKeyValue({ appId: "salesforce", keyPath: ["enabled"], value })
        )
      ).toMatchObject({ id });
    }
    expect(
      await withD1Database({ DB: db }, () =>
        repository.findByAppIdAndKeyValue({ appId: "salesforce", keyPath: ["missing"], value: "null" })
      )
    ).toBeNull();
  });

  it("retains whole-document equality for an empty property path", async () => {
    await insert(1, { id: "root" });
    expect(
      await withD1Database({ DB: db }, () =>
        repository.findByAppIdAndKeyValue({ appId: "salesforce", keyPath: [], value: { id: "root" } })
      )
    ).toMatchObject({ id: 1 });
  });
});
