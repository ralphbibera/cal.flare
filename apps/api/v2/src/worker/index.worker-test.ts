import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../../cloudflare.config";
import { prismaQueryCompiler } from "../../vitest.worker.config";
import { PrismaReadService } from "../modules/prisma/prisma-read.service";
import { PrismaWriteService } from "../modules/prisma/prisma-write.service";
import * as workerModule from "../worker";

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

    await db.batch([
      db
        .prepare(
          `INSERT INTO users (id, uuid, username, name, email, emailVerified, timeZone, locked)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          9001,
          "9001-uuid",
          "worker-user",
          "Worker User",
          "worker@calflare.test",
          null,
          "Europe/Paris",
          0
        ),
      db
        .prepare(
          `INSERT INTO users (id, uuid, username, name, email, emailVerified, timeZone, locked)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          9002,
          "9002-uuid",
          "locked-user",
          "Locked User",
          "locked@calflare.test",
          null,
          "Europe/Paris",
          1
        ),
    ]);
  }, 300_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("serves health under both public prefixes", async () => {
    for (const path of ["/v2/health", "/api/v2/health"]) {
      const response = await mf.dispatchFetch(`https://api.calflare.test${path}`);

      expect(response.status).toBe(200);
      expect(await response.text()).toBe("OK");
      expect(response.headers.get("content-type")).toContain("text/html");
    }
  });

  it("returns the source-shaped 404 outside the health routes", async () => {
    const response = await mf.dispatchFetch("https://api.calflare.test/api/health?probe=1");
    const body = (await response.json()) as {
      status: string;
      timestamp: string;
      path: string;
      error: { code: string; message: string; details: unknown };
    };

    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(body).toMatchObject({
      status: "error",
      path: "/api/health?probe=1",
      error: {
        code: "NotFoundException",
        message: "Cannot GET /api/health?probe=1",
        details: {
          message: "Cannot GET /api/health?probe=1",
          error: "Not Found",
          statusCode: 404,
        },
      },
    });
    expect(body.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  it("does not serve the copied profile endpoint", async () => {
    const response = await mf.dispatchFetch("https://api.calflare.test/api/v2/me");
    const body = (await response.json()) as { error: { code: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NotFoundException");
  });

  it("declares the RuntimeState Durable Object export", () => {
    expect(workerModule.RuntimeState).toBeTypeOf("function");
    expect(config.worker.exports?.RuntimeState).toMatchObject({ type: "durable-object", storage: "sqlite" });
  });

  it("applies the shared Prisma extensions through the v2 D1 services", async () => {
    await withD1Database({ DB: db }, async () => {
      const read = new PrismaReadService();
      read.setOptions({ type: "worker", d1: db });
      const write = new PrismaWriteService();
      write.setOptions({ type: "worker", d1: db });

      await expect(read.prisma.user.findUnique({ where: { id: 9002 } })).resolves.toBeNull();
      await expect(read.prisma.user.findFirst({ where: { id: 9002, locked: true } })).resolves.toMatchObject({
        id: 9002,
      });
      await expect(
        write.prisma.user.updateMany({ where: { id: undefined }, data: { name: "Worker User" } })
      ).rejects.toThrow('The value for the field "id" cannot be undefined.');
    });
  });
});
