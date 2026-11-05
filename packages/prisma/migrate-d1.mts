import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { parseArgs, promisify } from "node:util";
import { MiniflareWorkerConfigSchema } from "miniflare";
import { z } from "zod";
import { ErrorCode } from "../lib/errorCodes";
import { ErrorWithCode } from "../lib/errors";

const execute = promisify(execFile);
const webRoot = fileURLToPath(new URL("../../apps/web/", import.meta.url));
const configUrl = new URL("../../apps/web/cloudflare.config.ts", import.meta.url);
const webRequire = createRequire(join(webRoot, "package.json"));
const cfPackage = webRequire.resolve("cf/package.json");
const cf = join(dirname(cfPackage), "bin/cf");
const resultSchema = z
  .array(
    z.object({
      success: z.literal(true),
      results: z.object({ columns: z.array(z.string()), rows: z.array(z.array(z.unknown())) }),
    })
  )
  .min(1);
const historySchema = z.array(z.tuple([z.number().int().positive(), z.string(), z.string()]));
const targetSchema = z.object({
  worker: z.object({
    name: z.string(),
    compatibilityDate: z.string(),
    compatibilityFlags: z.array(z.string()),
    env: z.object({ DB: z.object({ type: z.literal("d1"), name: z.string(), id: z.string().optional() }) }),
  }),
});

type Query = { sql: string; params?: string[] };

async function migrateD1({
  persistTo = join(webRoot, ".cloudflare/state"),
  migrationsDirectory = fileURLToPath(new URL("./migrations-d1/", import.meta.url)),
}: {
  persistTo?: string;
  migrationsDirectory?: string;
} = {}) {
  const { version } = z
    .object({ version: z.literal("1.0.0-beta.27") })
    .parse(JSON.parse(await readFile(cfPackage, "utf8")));
  const { worker } = targetSchema.parse((await import(configUrl.href)).default);
  const config = MiniflareWorkerConfigSchema.parse({ ...worker, env: { DB: worker.env.DB } });
  const binding = config.env?.DB;
  if (binding?.type !== "d1" || !binding.id) {
    throw new ErrorWithCode(ErrorCode.BadRequest, "Web DB must resolve to a local D1 identity");
  }
  const migrations = await Promise.all(
    (await readdir(migrationsDirectory))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map(async (name) => {
        const bytes = await readFile(join(migrationsDirectory, name));
        return { name, hash: createHash("sha256").update(bytes).digest("hex"), sql: bytes.toString("utf8") };
      })
  );
  const temporary = await mkdtemp(join(tmpdir(), "calflare-migrate-d1-"));
  const batchPath = join(temporary, "batch.json");
  const persistence = resolve(persistTo);
  async function query(batch: Query[]) {
    await writeFile(batchPath, JSON.stringify(batch));
    try {
      // beta.27's local explorer exposes /raw, not /query. Whole SQL stays in workerd's parser.
      const { stdout } = await execute(
        process.env.npm_node_execpath || "node",
        [cf, "d1", "raw", binding.id, "--local", "--persist-to", persistence, "--batch", `@${batchPath}`],
        {
          cwd: temporary,
          env: Object.assign({}, process.env, { CI: "true", CLOUDFLARE_SEND_METRICS: "false" }),
          maxBuffer: 16 * 1024 * 1024,
        }
      );
      return resultSchema.parse(JSON.parse(stdout));
    } catch (cause) {
      throw new ErrorWithCode(ErrorCode.InternalServerError, `Local D1 batch failed: ${String(cause)}`);
    }
  }
  try {
    await query([
      {
        sql: `CREATE TABLE IF NOT EXISTS _calflare_migrations (
          position INTEGER NOT NULL PRIMARY KEY,
          name TEXT NOT NULL UNIQUE,
          hash TEXT NOT NULL,
          applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%f+00:00', 'now'))
        )`,
      },
    ]);
    const [historyResult] = await query([
      { sql: "SELECT position, name, hash FROM _calflare_migrations ORDER BY position" },
    ]);
    const history = historySchema.parse(historyResult?.results.rows);
    for (const [index, [position, name, hash]] of history.entries()) {
      const migration = migrations[index];
      if (position !== index + 1 || migration?.name !== name || migration.hash !== hash) {
        throw new ErrorWithCode(ErrorCode.BadRequest, `D1 migration history/checksum mismatch: ${name}`);
      }
    }
    for (const [index, migration] of migrations.entries()) {
      if (index < history.length) continue;
      await query([
        { sql: migration.sql },
        {
          sql: "INSERT INTO _calflare_migrations (position, name, hash) VALUES (?, ?, ?)",
          params: [String(index + 1), migration.name, migration.hash],
        },
      ]);
    }
    return {
      applied: migrations.length - history.length,
      total: migrations.length,
      database: binding.id,
      persistence,
      version,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: { "local-only": { type: "boolean" }, "persist-to": { type: "string" } },
      strict: true,
      allowPositionals: false,
    });
    if (!values["local-only"]) {
      throw new ErrorWithCode(
        ErrorCode.Forbidden,
        "D1 migrations require --local-only; remote execution is unavailable"
      );
    }
    process.stdout.write(`${JSON.stringify(await migrateD1({ persistTo: values["persist-to"] }))}\n`);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}

export { migrateD1 };
