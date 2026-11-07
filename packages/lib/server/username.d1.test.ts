import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { usernameCheck } from "./username";

describe("organization username availability", () => {
  let directory: string;
  let runtime: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-org-usernames-"));
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
    await db.batch([
      db.prepare(`INSERT INTO "Team" ("id", "name", "slug", "isOrganization", "metadata") VALUES
        (1, 'Organization', 'current', 1, '{"requestedSlug":"requested"}'),
        (2, 'Non-organization', 'team', 0, '{"requestedSlug":"not-an-org"}'),
        (3, 'Missing', 'missing', 1, '{}'), (4, 'Null', 'null-metadata', 1, '{"requestedSlug":null}'),
        (5, 'SQL null', 'sql-null-metadata', 1, null)`),
      db.prepare(`INSERT INTO users (id, uuid, email, username, organizationId) VALUES
        (1, 'org-member', 'member@example.invalid', 'member', 1),
        (2, 'global-member', 'global@example.invalid', 'global', null)`),
    ]);
  }, 120_000);

  afterAll(async () => {
    await runtime?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it.each(["current", "requested"])("resolves %s to the organization namespace", async (domain) => {
    expect(await withD1Database({ DB: db }, () => usernameCheck("member", domain))).toMatchObject({
      available: false,
      suggestedUsername: "member001",
    });
    expect(await withD1Database({ DB: db }, () => usernameCheck("global", domain))).toMatchObject({
      available: true,
    });
  });

  it.each([
    "not-an-org",
    "unknown",
    "null",
  ])("rejects an unmatched organization domain %s", async (domain) => {
    await expect(withD1Database({ DB: db }, () => usernameCheck("member", domain))).rejects.toThrow(
      `Organization with domain "${domain}" not found`
    );
  });
});
