import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../../cloudflare.config";
import * as workerModule from "../worker";

const PRISMA_WASM_PREFIX = "\0prisma-query-compiler:";
const API_KEY_PREFIX = "cal_";

// Prisma's D1 client loads its query compiler through Wrangler's `?module` import. Vite has no
// equivalent, so the test bundle compiles the same bytes into a WebAssembly.Module directly.
function prismaQueryCompiler() {
  return {
    name: "api-v2-prisma-query-compiler",
    enforce: "pre" as const,
    resolveId(source: string, importer: string | undefined) {
      if (!source.endsWith(".wasm?module") || !importer) return;
      const file = fileURLToPath(new URL(source.slice(0, -"?module".length), pathToFileURL(importer)));
      return `${PRISMA_WASM_PREFIX}${file}`;
    },
    load(id: string) {
      if (!id.startsWith(PRISMA_WASM_PREFIX)) return;
      const wasm = readFileSync(id.slice(PRISMA_WASM_PREFIX.length)).toString("base64");
      return `const bytes = Uint8Array.from(atob("${wasm}"), (value) => value.charCodeAt(0));\nexport default new WebAssembly.Module(bytes);`;
    },
  };
}

async function buildWorker(directory: string): Promise<string> {
  const appRoot = fileURLToPath(new URL("../..", import.meta.url));
  const tsconfig = JSON.parse(readFileSync(join(appRoot, "tsconfig.json"), "utf8")) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const alias = Object.entries(tsconfig.compilerOptions.paths).map(([find, [target]]) => ({
    find: new RegExp(`^${find.replace("*", "(.*)")}$`),
    replacement: join(appRoot, target.replace("*", "$1")),
  }));

  await build({
    configFile: false,
    root: appRoot,
    publicDir: false,
    logLevel: "error",
    resolve: {
      alias,
      conditions: ["workerd", "worker", "import", "default"],
      noExternal: true,
    },
    define: { "process.env.NODE_ENV": '"production"', __dirname: '"/"', __filename: '"/worker.js"' },
    plugins: [prismaQueryCompiler()],
    build: {
      ssr: "src/worker.ts",
      outDir: directory,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          entryFileNames: "worker.js",
          inlineDynamicImports: true,
          banner:
            'import { createRequire as __createRequire } from "node:module"; const require = __createRequire("/");',
        },
      },
    },
    ssr: { noExternal: true, target: "webworker" },
  });
  return readFile(join(directory, "worker.js"), "utf8");
}

describe("api v2 Worker host in workerd", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  let apiKey: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-api-v2-worker-"));
    const persistTo = join(directory, "state");
    // The migration CLI derives the local D1 identity from the web Worker's binding, so the test
    // Worker must reuse that identity to read the same database.
    const { database } = await migrateD1({ persistTo });
    const workerSource = await buildWorker(join(directory, "bundle"));

    const { worker } = config;
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
            env: { DB: { ...worker.env.DB, id: database } },
            manifest: {
              mainModule: "worker.js",
              modules: { "worker.js": { type: "esm", contents: workerSource } },
            },
          },
        },
      ],
    });
    db = await mf.getD1Database("DB");

    apiKey = `${API_KEY_PREFIX}${crypto.randomUUID().replaceAll("-", "")}`;
    const hashedKey = createHash("sha256").update(apiKey.slice(API_KEY_PREFIX.length)).digest("hex");
    await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, uuid, username, name, email, emailVerified, timeZone)
           VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(9001, "9001-uuid", "worker-user", "Worker User", "worker@calflare.test", null, "Europe/Paris"),
      db
        .prepare(`INSERT INTO "ApiKey" (id, "userId", "hashedKey") VALUES (?, ?, ?)`)
        .bind("worker-api-key", 9001, hashedKey),
    ]);
  }, 300_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("serves the version-neutral health route under the public prefix only", async () => {
    const response = await mf.dispatchFetch("https://api.calflare.test/api/v2/health", {
      headers: { Origin: "https://app.calflare.test" },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("OK");
    expect(response.headers.get("content-type")).toContain("text/html");
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const outside = await mf.dispatchFetch("https://api.calflare.test/api/health");
    const body = (await outside.json()) as { status: string; error: { code: string } };
    expect(outside.status).toBe(404);
    expect(body.status).toBe("error");
    expect(body.error.code).toBe("NotFoundException");
  });

  it("serves the versioned, guarded profile endpoint for an API key", async () => {
    const response = await mf.dispatchFetch("https://api.calflare.test/api/v2/me", {
      headers: { authorization: `Bearer ${apiKey}`, "cal-api-version": "2024-08-13" },
    });
    const body = (await response.json()) as {
      status: string;
      data: { id: number; email: string; name: string; username: string; timeZone: string };
    };

    expect(response.status).toBe(200);
    expect(body.status).toBe("success");
    expect(body.data).toMatchObject({
      id: 9001,
      email: "worker@calflare.test",
      name: "Worker User",
      username: "worker-user",
      timeZone: "Europe/Paris",
    });
    expect(response.headers.get("x-request-id")).toMatch(/^[0-9a-f-]{36}$/);

    const fallback = await mf.dispatchFetch("https://api.calflare.test/v2/me", {
      headers: { authorization: `Bearer ${apiKey}`, "cal-api-version": "2020-01-01" },
    });
    expect(fallback.status).toBe(200);
  });

  it("returns 401 for a missing API key and for one that is not in D1", async () => {
    const missing = await mf.dispatchFetch("https://api.calflare.test/api/v2/me");
    const missingBody = (await missing.json()) as {
      status: string;
      path: string;
      error: { code: string; message: string };
    };

    expect(missing.status).toBe(401);
    expect(missingBody.status).toBe("error");
    expect(missingBody.path).toBe("/api/v2/me");
    expect(missingBody.error.code).toBe("UnauthorizedException");
    expect(missingBody.error.message).toContain("No authentication method provided");

    const unknown = await mf.dispatchFetch("https://api.calflare.test/api/v2/me", {
      headers: { authorization: `Bearer ${API_KEY_PREFIX}missing` },
    });
    const unknownBody = (await unknown.json()) as { error: { message: string } };
    expect(unknown.status).toBe(401);
    expect(unknownBody.error.message).toContain("Your api key is not valid");
  });

  it("declares the RuntimeState Durable Object export", () => {
    expect(workerModule.RuntimeState).toBeTypeOf("function");
    expect(config.worker.exports?.RuntimeState).toMatchObject({ type: "durable-object", storage: "sqlite" });
  });
});
