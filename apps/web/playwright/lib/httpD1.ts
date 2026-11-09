import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";
import type { D1RequestScope } from "@calcom/prisma/d1";
import type {
  D1Database,
  D1DatabaseSession,
  D1ExecResult,
  D1PreparedStatement,
  D1Result,
} from "@cloudflare/workers-types";

const repoRoot = resolve(__dirname, "../../../..");
const d1StorageKey = Symbol.for("calflare.d1.request-storage");
const prismaInternal = pathToFileURL(join(repoRoot, "packages/prisma/generated/prisma/internal/")).href;
const bunWasmLoader = resolve(repoRoot, "packages/prisma/tooling/bun-wasm-loader.mjs");

type D1RequestStorage = { getStore(): D1RequestScope | undefined };

const bytesReviver = (_key: string, value: unknown) => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return value;
  const bytes = (value as { __calflareBytes?: unknown }).__calflareBytes;
  if (!Array.isArray(bytes)) return value;
  return Uint8Array.from(bytes).buffer;
};

const bytesReplacer = (_key: string, value: unknown) => {
  if (value instanceof ArrayBuffer) return { __calflareBytes: Array.from(new Uint8Array(value)) };
  return value;
};

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

class HttpD1Statement implements D1PreparedStatement {
  constructor(
    private readonly database: HttpD1Database,
    readonly sql: string,
    readonly params: unknown[] = []
  ) {}

  bind(...values: unknown[]): D1PreparedStatement {
    return new HttpD1Statement(this.database, this.sql, values);
  }

  async first<T = unknown>(colName: string): Promise<T | null>;
  async first<T = Record<string, unknown>>(): Promise<T | null>;
  async first<T = unknown>(colName?: string): Promise<T | null> {
    const row = await this.database.request({
      kind: "batch",
      statements: [{ sql: this.sql, params: this.params, mode: "first" }],
    });
    if (!row || typeof row !== "object") return null;
    return (colName ? ((row as Record<string, unknown>)[colName] ?? null) : row) as T | null;
  }

  async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.request({
      kind: "batch",
      statements: [{ sql: this.sql, params: this.params, mode: "run" }],
    }) as Promise<D1Result<T>>;
  }

  async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
    return this.database.request({
      kind: "batch",
      statements: [{ sql: this.sql, params: this.params, mode: "all" }],
    }) as Promise<D1Result<T>>;
  }

  async raw<T = unknown[]>(options: { columnNames: true }): Promise<[string[], ...T[]]>;
  async raw<T = unknown[]>(options?: { columnNames?: false }): Promise<T[]>;
  async raw<T = unknown[]>(options?: { columnNames?: boolean }): Promise<T[] | [string[], ...T[]]> {
    const rows = (await this.database.request({
      kind: "batch",
      statements: [{ sql: this.sql, params: this.params, mode: "raw" }],
    })) as [string[], ...T[]];
    return options?.columnNames ? rows : rows.slice(1);
  }
}

/**
 * Implements the D1 surface Prisma's adapter and the Playwright fixtures use. Every operation
 * reaches the preview Worker, which owns the only connection to the e2e SQLite file.
 */
export class HttpD1Database implements D1Database {
  constructor(private readonly options: { baseURL: string; token: string }) {}

  prepare(query: string): D1PreparedStatement {
    return new HttpD1Statement(this, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
    const result = await this.request({
      kind: "batch",
      statements: statements.map((statement) => {
        if (!(statement instanceof HttpD1Statement)) {
          throw new Error("The e2e D1 bridge can only batch its own prepared statements");
        }
        return { sql: statement.sql, params: statement.params, mode: "all" as const };
      }),
    });
    return (Array.isArray(result) ? result : [result]) as D1Result<T>[];
  }

  async exec(query: string): Promise<D1ExecResult> {
    return this.request({ kind: "exec", sql: query }) as Promise<D1ExecResult>;
  }

  withSession(): D1DatabaseSession {
    throw new Error("The e2e D1 bridge does not support sessions");
  }

  dump(): Promise<ArrayBuffer> {
    throw new Error("The e2e D1 bridge does not support dump");
  }

  async request(body: unknown): Promise<unknown> {
    const baseURL = this.options.baseURL.replace(/\/+$/, "");
    const response = await fetch(`${baseURL}/__e2e/d1`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-e2e-d1-token": this.options.token },
      body: JSON.stringify(body, bytesReplacer),
    });
    const text = await response.text();
    const payload = text ? JSON.parse(text, bytesReviver) : undefined;
    if (!response.ok) {
      const message = (payload as { error?: { message?: unknown } } | undefined)?.error?.message;
      throw new Error(
        typeof message === "string" ? message : `The e2e D1 bridge failed with HTTP ${response.status}`
      );
    }
    return payload;
  }
}

export async function createFixtureD1() {
  await registerPrismaWasmLoader();
  const token = process.env.E2E_D1_TOKEN;
  if (!token) {
    throw new Error("E2E_D1_TOKEN is required. Run Playwright through playwright.config.ts.");
  }
  return new HttpD1Database({
    baseURL: process.env.NEXT_PUBLIC_WEBAPP_URL ?? "http://localhost:3000",
    token,
  });
}

/**
 * Playwright invokes the test body outside the async context of fixture setup, so the request-scoped
 * AsyncLocalStorage never sees the fixture D1. Requests handled in this process still win; everything
 * else in the worker process reads the database through the preview Worker's bridge.
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
