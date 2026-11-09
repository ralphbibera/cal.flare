import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { D1RequestScope } from "@calcom/prisma/d1";
import type { D1Database } from "@cloudflare/workers-types";
// Ensure the shared request-storage instance exists before the Playwright process binds it.
import "@calcom/prisma/d1";
import { Miniflare } from "miniflare";
import { z } from "zod";

const repoRoot = resolve(__dirname, "../../../..");
// Global setup writes this once; every test worker reads it instead of re-running migrations.
const targetFile = join(repoRoot, "test-results", ".local-d1-target.json");
const d1StorageKey = Symbol.for("calflare.d1.request-storage");
const prismaInternal = pathToFileURL(join(repoRoot, "packages/prisma/generated/prisma/internal/")).href;
const bunWasmLoader = resolve(repoRoot, "packages/prisma/tooling/bun-wasm-loader.mjs");

const targetSchema = z.object({ database: z.string().min(1), persistence: z.string().min(1) });

export type LocalD1Target = z.infer<typeof targetSchema>;

type D1RequestStorage = { getStore(): D1RequestScope | undefined };

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
export async function prepareLocalD1(): Promise<LocalD1Target> {
  let target = runD1Script("db-deploy:d1");
  if (!(await isSeeded(target))) {
    target = runD1Script("db-seed:d1");
  }
  mkdirSync(dirname(targetFile), { recursive: true });
  writeFileSync(targetFile, JSON.stringify(target));
  return target;
}

export function readLocalD1Target(): LocalD1Target {
  try {
    return targetSchema.parse(JSON.parse(readFileSync(targetFile, "utf8")));
  } catch (cause) {
    throw new Error(
      `Local D1 is not prepared. Run the suite through Playwright so global setup seeds it. (${String(cause)})`
    );
  }
}

// Prisma's generated client imports its query compiler as WebAssembly. Bun's loader understands
// `?module`, but Node treats the generated JS runtime as CommonJS and has no WASM import at all.
async function registerPrismaWasmLoader() {
  if (process.versions.bun) {
    await import(bunWasmLoader);
    return;
  }
  const { registerHooks } = await import("node:module");
  const runtimeUrl = `${prismaInternal}query_compiler_bg.js`;
  const compilerUrl = `${prismaInternal}query_compiler_bg.wasm?module`;
  registerHooks({
    resolve(specifier, context, nextResolve) {
      if (!context.parentURL?.startsWith(prismaInternal)) return nextResolve(specifier, context);
      const resolved = new URL(specifier, context.parentURL).href;
      if (resolved === runtimeUrl || resolved === compilerUrl) return { url: resolved, shortCircuit: true };
      return nextResolve(specifier, context);
    },
    load(url, context, nextLoad) {
      if (url === compilerUrl) {
        const file = fileURLToPath(url.slice(0, -"?module".length));
        return {
          format: "module",
          shortCircuit: true,
          source: `import { readFileSync } from "node:fs";
export default new WebAssembly.Module(readFileSync(${JSON.stringify(file)}));`,
        };
      }
      if (url === runtimeUrl) {
        return { format: "module", shortCircuit: true, source: readFileSync(new URL(url), "utf8") };
      }
      return nextLoad(url, context);
    },
  });
}

const busyError = /SQLITE_BUSY|database is locked|Failed to get session commit token/i;
const asyncStatementMethods = new Set(["run", "all", "first", "raw"]);

// Every Playwright worker process opens its own Miniflare handle on the same SQLite file, so
// concurrent fixture writes can race the preview Worker. D1 reports the transient lock as an
// error instead of waiting, so retry those operations with a short backoff.
async function retryWhileBusy<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 1; ; attempt++) {
    try {
      return await operation();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (attempt >= 20 || !busyError.test(message)) throw error;
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 25 * attempt));
    }
  }
}

function retryStatement(statement: D1PreparedStatement): D1PreparedStatement {
  return new Proxy(statement, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "bind") {
        return (...values: unknown[]) => retryStatement(value.apply(target, values) as D1PreparedStatement);
      }
      if (asyncStatementMethods.has(String(property))) {
        return (...args: unknown[]) => retryWhileBusy(() => value.apply(target, args) as Promise<unknown>);
      }
      return value.bind(target);
    },
  });
}

function retryDatabase(database: D1Database): D1Database {
  return new Proxy(database, {
    get(target, property) {
      const value = Reflect.get(target, property, target);
      if (typeof value !== "function") return value;
      if (property === "prepare") {
        return (query: string) => retryStatement(value.call(target, query) as D1PreparedStatement);
      }
      if (property === "batch") {
        return (statements: D1PreparedStatement[]) => retryWhileBusy(() => value.call(target, statements));
      }
      return value.bind(target);
    },
  });
}

// Opens the same persisted database identity that `apps/web preview` serves to the browser.
export async function openLocalD1(target: LocalD1Target = readLocalD1Target()) {
  await registerPrismaWasmLoader();
  const mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(target.persistence, "v3"),
    workers: [
      {
        config: {
          // A unique name per process keeps each Miniflare handle's D1 session state separate.
          name: `calflare-e2e-fixtures-${process.pid}`,
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
  return { mf, db: retryDatabase(db) };
}

/**
 * Playwright invokes the test body outside the async context of fixture setup, so the request-scoped
 * AsyncLocalStorage never sees the fixture D1. Requests handled in this process still win; everything
 * else in the worker process reads the local database opened from the preview Worker's persist root.
 */
export function bindFixtureD1(db: D1Database): () => void {
  const shared = globalThis as unknown as Record<symbol, D1RequestStorage | undefined>;
  const storage = shared[d1StorageKey];
  if (!storage) {
    throw new Error("Prisma D1 request storage is unavailable in the Playwright process");
  }
  const fixtureScope = { database: db };
  const getRequestStore = storage.getStore;
  storage.getStore = function () {
    return getRequestStore.call(this) ?? fixtureScope;
  };
  return () => {
    storage.getStore = getRequestStore;
  };
}
