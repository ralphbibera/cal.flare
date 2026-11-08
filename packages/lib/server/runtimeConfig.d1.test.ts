import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getRuntimeConfigValue } from "./runtimeConfig";

describe("D1 runtime config", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  let empty: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-runtime-config-"));
    const persistTo = join(directory, "state");
    await migrateD1({ persistTo });
    const { worker } = (await import("../../../apps/web/cloudflare.config")).default;
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
            env: {
              DB: worker.env.DB,
              EMPTY: { type: "d1", name: "runtime-config-empty", dev: { remote: false } },
            },
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
    empty = await runtime.getD1Database("EMPTY");
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  const read = (key: string, database = db) =>
    withD1Database({ DB: database }, () => getRuntimeConfigValue(key));

  it("keeps signup enabled from the seeded row", async () => {
    expect(await read("isSignupDisabled")).toBe(false);
  });

  it("returns the stored JSON value", async () => {
    await db
      .prepare('INSERT INTO "RuntimeConfig" ("key", "valueJson") VALUES (?, ?)')
      .bind("featureFlag", "true")
      .run();

    expect(await read("featureFlag")).toBe(true);
  });

  it("returns undefined for a missing key", async () => {
    expect(await read("missing")).toBeUndefined();
  });

  it("returns undefined for a malformed row", async () => {
    await db
      .prepare('INSERT INTO "RuntimeConfig" ("key", "valueJson") VALUES (?, ?)')
      .bind("malformed", "{")
      .run();

    expect(await read("malformed")).toBeUndefined();
  });

  it("returns undefined when the table cannot be read", async () => {
    expect(await read("isSignupDisabled", empty)).toBeUndefined();
  });
});
