import { execFileSync } from "node:child_process";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { D1Database } from "@cloudflare/workers-types";
import { Miniflare } from "miniflare";
import { z } from "zod";

const repoRoot = resolve(__dirname, "../../../..");

const targetSchema = z.object({ database: z.string().min(1), persistence: z.string().min(1) });

export type LocalD1Target = z.infer<typeof targetSchema>;

function runD1Script(script: string): LocalD1Target {
  const stdout = execFileSync("bun", ["run", "--cwd", "packages/prisma", script, "--local-only"], {
    cwd: repoRoot,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "inherit"],
  });
  // The D1 scripts print their migration summary as the last stdout line.
  return targetSchema.parse(JSON.parse(stdout.trim().split("\n").at(-1) ?? ""));
}

// Global setup owns migrations and seeding. Test fixtures reach D1 through the preview Worker, which
// is the only long-lived writer while tests run.
async function openLocalD1(target: LocalD1Target) {
  const mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(target.persistence, "v3"),
    workers: [
      {
        config: {
          name: "calflare-e2e-migrate",
          compatibilityDate: "2026-11-04",
          compatibilityFlags: ["nodejs_compat"],
          env: { DB: { type: "d1", id: target.database } },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default { fetch() { return new Response(); } }" },
            },
          },
        },
      },
    ],
  });
  const db = (await mf.getD1Database("DB")) as D1Database;
  return { mf, db };
}

async function isSeeded(target: LocalD1Target) {
  const { mf, db } = await openLocalD1(target);
  try {
    const row = await db.prepare('SELECT COUNT(*) AS count FROM "users"').first<{ count: number }>();
    return (row?.count ?? 0) > 0;
  } catch {
    // A fresh database has no schema yet.
    return false;
  } finally {
    await mf.dispose();
  }
}

// Migrate first, then seed only a database that has no baseline rows. The retained Postgres seed
// is not fully idempotent on D1, so rerunning it against an existing local database logs avoidable
// uniqueness errors.
export async function prepareLocalD1() {
  const target = runD1Script("db-deploy:d1");
  if (!(await isSeeded(target))) {
    runD1Script("db-seed:d1");
  }
}
