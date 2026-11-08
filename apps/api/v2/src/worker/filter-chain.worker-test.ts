import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../../cloudflare.config";
import { prismaQueryCompiler, workerResolveAliases } from "../../vitest.worker.config";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

async function buildWorker(directory: string): Promise<string> {
  const appRoot = fileURLToPath(new URL("../..", import.meta.url));
  const alias = workerResolveAliases(appRoot);

  await build({
    configFile: false,
    root: appRoot,
    publicDir: false,
    logLevel: "error",
    resolve: { alias, conditions: ["workerd", "worker", "import", "default"], noExternal: true },
    define: { "process.env.NODE_ENV": '"production"', __dirname: '"/"', __filename: '"/worker.js"' },
    plugins: [prismaQueryCompiler()],
    build: {
      ssr: "src/worker/filter-chain-test-entry.ts",
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

function createTestWorker({
  workerSource,
  database,
  persistTo,
}: {
  workerSource: string;
  database: string;
  persistTo: string;
}): Miniflare {
  const { worker } = config;
  return new Miniflare({
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
}

describe("api v2 filter chain in workerd", () => {
  let directory: string;
  let mf: Miniflare;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-api-v2-filters-"));
    const persistTo = join(directory, "state");
    const { database } = await migrateD1({ persistTo });
    const workerSource = await buildWorker(join(directory, "bundle"));
    mf = createTestWorker({ workerSource, database, persistTo });
  }, 300_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  function request(path: string) {
    return mf.dispatchFetch(`https://api.calflare.test${path}`);
  }

  it("registers the five source filters in Nest's effective order", async () => {
    const response = await request("/probe/filters");

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      order: [
        "CalendarServiceExceptionFilter",
        "TRPCExceptionFilter",
        "HttpExceptionFilter",
        "ZodExceptionFilter",
        "PrismaExceptionFilter",
        "WorkerExceptionFilter",
      ],
    });
  });

  it("routes every source filter envelope", async () => {
    const cases = [
      ["/probe/http/not-found", 404, "NotFoundException", "missing"],
      ["/probe/http/unauthorized", 401, "UnauthorizedException", "no token"],
      ["/probe/http/forbidden", 403, "ForbiddenException", "denied"],
      ["/probe/zod", 400, "BAD_REQUEST", "name - Required, "],
      ["/probe/prisma", 409, "CONFLICT", "Invalid Input: Trying to create a record that already exists."],
      ["/probe/trpc", 404, "TRPCError", "gone"],
      ["/probe/calendar", 400, "CalendarAppError", "calendar broke"],
    ] as const;

    for (const [path, status, code, message] of cases) {
      const response = await request(path);
      expect(response.status, path).toBe(status);
      expect(response.headers.get("x-request-id"), path).toMatch(UUID);
      expect(await response.json(), path).toMatchObject({
        status: "error",
        path,
        error: { code, message },
      });
    }
  });

  it("returns the BaseExceptionFilter body for an unknown error", async () => {
    const response = await request("/probe/unknown");

    expect(response.status).toBe(500);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("x-request-id")).toMatch(UUID);
    expect(await response.json()).toEqual({ statusCode: 500, message: "Internal server error" });
  });

  it("runs route filters before globals and method filters before class filters", async () => {
    const oauth2 = await request("/probe/oauth2");
    expect(oauth2.status).toBe(400);
    expect(await oauth2.json()).toEqual({ error: "invalid_request", error_description: "bad code" });

    const order = await request("/probe/order");
    expect(order.status).toBe(409);
    expect(await order.json()).toEqual({ by: "method" });
  });

  it("sets X-Request-Id on success and routes a miss through NotFoundException", async () => {
    const success = await request("/probe/success");
    expect(success.status).toBe(200);
    expect(success.headers.get("x-request-id")).toMatch(UUID);
    expect(await success.json()).toEqual({ ok: true });

    const missing = await request("/v2/does-not-exist?trace=1");
    expect(missing.status).toBe(404);
    expect(missing.headers.get("x-request-id")).toMatch(UUID);
    expect(await missing.json()).toMatchObject({
      status: "error",
      path: "/v2/does-not-exist?trace=1",
      error: {
        code: "NotFoundException",
        message: "Cannot GET /v2/does-not-exist?trace=1",
      },
    });
  });
});
