import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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
const d1TemplateEnv = "CALFLARE_D1_TEMPLATE";
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
const databaseListSchema = z.array(z.object({ uuid: z.string().min(1), name: z.string() }));

type Query = { sql: string; params?: string[] };

const defaultMigrationsDirectory = fileURLToPath(new URL("./migrations-d1/", import.meta.url));

async function readMigrations(directory = defaultMigrationsDirectory) {
  return Promise.all(
    (await readdir(directory))
      .filter((name) => name.endsWith(".sql"))
      .sort()
      .map(async (name) => {
        const bytes = await readFile(join(directory, name));
        return { name, hash: createHash("sha256").update(bytes).digest("hex"), sql: bytes.toString("utf8") };
      })
  );
}

function migrationsFingerprint(migrations: { name: string; hash: string }[]) {
  return migrations.map(({ name, hash }) => `${name} ${hash}`).join("\n");
}

// Written beside the template by the Vitest global setup, so a copy is only trusted for the exact
// migration files that produced it.
function templateManifestPath(template: string) {
  return join(dirname(template), "migrations.txt");
}

async function isEmptyOrMissing(directory: string) {
  const entries = await readdir(directory).catch(() => null);
  return !entries || entries.length === 0;
}

const QUERY_TIMEOUT_MS = 120_000;

function migrationMode(values: { "local-only"?: boolean; remote?: boolean; "persist-to"?: string }) {
  const remote = values.remote === true;
  if (remote === (values["local-only"] === true)) {
    throw new ErrorWithCode(
      ErrorCode.Forbidden,
      "D1 migrations require exactly one of --local-only or --remote"
    );
  }
  if (remote && values["persist-to"] !== undefined) {
    throw new ErrorWithCode(ErrorCode.BadRequest, "--persist-to is only available with --local-only");
  }
  return { remote, persistTo: values["persist-to"] };
}

function selectRemoteDatabase(databases: { uuid: string; name: string }[], name: string) {
  const matches = databases.filter((database) => database.name === name);
  if (matches.length !== 1) {
    throw new ErrorWithCode(
      ErrorCode.BadRequest,
      `Expected one remote D1 database named ${name}, found ${matches.length}`
    );
  }
  return matches[0].uuid;
}

async function remoteDatabaseId(name: string) {
  try {
    const { stdout } = await execute(
      process.env.npm_node_execpath || "node",
      [cf, "d1", "list", "--per-page", "1000"],
      {
        env: Object.assign({}, process.env, { CI: "true", CLOUDFLARE_SEND_METRICS: "false" }),
        maxBuffer: 16 * 1024 * 1024,
        timeout: QUERY_TIMEOUT_MS,
        killSignal: "SIGKILL",
      }
    );
    return selectRemoteDatabase(databaseListSchema.parse(JSON.parse(stdout)), name);
  } catch (cause) {
    if (cause instanceof ErrorWithCode) throw cause;
    throw new ErrorWithCode(
      ErrorCode.InternalServerError,
      `Unable to resolve remote D1 database ${name}: ${String(cause)}`
    );
  }
}

async function migrateD1({
  persistTo,
  migrationsDirectory,
  useTemplate = true,
  remote = false,
}: {
  persistTo?: string;
  migrationsDirectory?: string;
  useTemplate?: boolean;
  remote?: boolean;
} = {}) {
  if (remote && persistTo !== undefined) {
    throw new ErrorWithCode(ErrorCode.BadRequest, "--persist-to is only available with --local-only");
  }
  const { version } = z
    .object({ version: z.literal("1.0.0-beta.27") })
    .parse(JSON.parse(await readFile(cfPackage, "utf8")));
  const { worker } = targetSchema.parse((await import(configUrl.href)).default);
  const config = MiniflareWorkerConfigSchema.parse({ ...worker, env: { DB: worker.env.DB } });
  const binding = config.env?.DB;
  const databaseName = worker.env.DB.name;
  const localDatabase = binding?.type === "d1" ? binding.id : undefined;
  if (!remote && !localDatabase) {
    throw new ErrorWithCode(ErrorCode.BadRequest, "Web DB must resolve to a local D1 identity");
  }
  const target = remote ? await remoteDatabaseId(databaseName) : localDatabase;
  if (!target) {
    throw new ErrorWithCode(ErrorCode.BadRequest, "Web DB must resolve to a D1 database");
  }
  const migrations = await readMigrations(migrationsDirectory);
  const persistence = resolve(persistTo ?? join(webRoot, ".cloudflare/state"));
  const template = process.env[d1TemplateEnv];
  // Only the Vitest global setup sets CALFLARE_D1_TEMPLATE; production never does. The CLI passes
  // useTemplate: false so a test process that exports the variable cannot make `--local-only` report
  // migrations that it never ran.
  if (
    useTemplate &&
    template &&
    persistTo !== undefined &&
    migrationsDirectory === undefined &&
    (await readFile(templateManifestPath(template), "utf8").catch(() => null)) ===
      migrationsFingerprint(migrations) &&
    (await isEmptyOrMissing(persistence))
  ) {
    await cp(template, persistence, { recursive: true });
    return {
      applied: migrations.length,
      total: migrations.length,
      database: target,
      persistence,
      remote: false,
      version,
    };
  }
  const temporary = await mkdtemp(join(tmpdir(), "calflare-migrate-d1-"));
  const batchPath = join(temporary, "batch.json");
  async function query(batch: Query[]) {
    await writeFile(batchPath, JSON.stringify(batch));
    const args = [cf, "d1", "raw", target];
    if (!remote) args.push("--local", "--persist-to", persistence);
    args.push("--batch", `@${batchPath}`);
    try {
      // beta.27 exposes /raw for both targets; a batch keeps whole SQL inside SQLite's parser.
      const { stdout } = await execute(process.env.npm_node_execpath || "node", args, {
        cwd: temporary,
        env: Object.assign({}, process.env, { CI: "true", CLOUDFLARE_SEND_METRICS: "false" }),
        maxBuffer: 16 * 1024 * 1024,
        // A stalled CLI would otherwise hang the caller until its own much longer timeout.
        timeout: QUERY_TIMEOUT_MS,
        killSignal: "SIGKILL",
      });
      return resultSchema.parse(JSON.parse(stdout));
    } catch (cause) {
      throw new ErrorWithCode(
        ErrorCode.InternalServerError,
        `${remote ? "Remote" : "Local"} D1 batch failed: ${String(cause)}`
      );
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
      database: remote ? databaseName : target,
      ...(remote ? {} : { persistence }),
      remote,
      version,
    };
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { values } = parseArgs({
      options: {
        "local-only": { type: "boolean" },
        remote: { type: "boolean" },
        "persist-to": { type: "string" },
      },
      strict: true,
      allowPositionals: false,
    });
    const target = migrationMode(values);
    process.stdout.write(`${JSON.stringify(await migrateD1({ ...target, useTemplate: false }))}\n`);
  } catch (error) {
    process.stderr.write(`${String(error)}\n`);
    process.exitCode = 1;
  }
}

export {
  d1TemplateEnv,
  migrateD1,
  migrationMode,
  migrationsFingerprint,
  readMigrations,
  selectRemoteDatabase,
  templateManifestPath,
};
