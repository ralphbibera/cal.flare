import "reflect-metadata";

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { withD1Database } from "@calcom/prisma/d1";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import {
  Body,
  Controller,
  Get,
  Header,
  Headers,
  HttpCode,
  Param,
  Post,
  Redirect,
  Version,
} from "@nestjs/common";
import { PATH_METADATA } from "@nestjs/common/constants";
import { Miniflare } from "miniflare";
import { build } from "vite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import config from "../../cloudflare.config";
import { prismaQueryCompiler, workerResolveAliases } from "../../vitest.worker.config";
import { AppController } from "../app.controller";
import { PrismaReadService } from "../modules/prisma/prisma-read.service";
import { PrismaWriteService } from "../modules/prisma/prisma-write.service";
import * as workerModule from "../worker";
import { createApiApp, resolveInnerPath, rewritePath } from "./app";
import { modules } from "./composition";
import type { ModuleDefinition, ModuleScope } from "./metadata";
import { buildRouteTable, defineModule } from "./metadata";

async function buildWorker(directory: string): Promise<string> {
  const appRoot = fileURLToPath(new URL("../..", import.meta.url));
  const alias = workerResolveAliases(appRoot);

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

@Controller({ path: "probe", version: ["2024-04-15", "2024-06-14"] })
class ProbeController {
  @Get(":id")
  @Version("2024-06-14")
  @HttpCode(202)
  @Header("x-probe", "yes")
  probe(@Headers("x-client") client: string, @Param("id") id: string): { id: string; client: string } {
    return { id, client };
  }

  @Post()
  create(@Body() body: unknown): unknown {
    return body;
  }

  @Get("redirect")
  @Redirect("https://example.test", 308)
  moved(): { url: string } {
    return { url: "https://example.test/moved" };
  }
}

const probeModule: ModuleDefinition = defineModule({
  key: "probe",
  controllers: [ProbeController],
  create(): ModuleScope {
    return { controllers: new Map([[ProbeController, new ProbeController()]]) };
  },
});

describe("public rewrite table", () => {
  it("maps health aliases and the source rewrites in source order", () => {
    expect(rewritePath("/v2/health", {})).toBe("/health");
    expect(rewritePath("/v2/health/", {})).toBe("/health");
    expect(rewritePath("/api/v2/health", {})).toBe("/health");
    expect(rewritePath("/api/v2/health/", {})).toBe("/health");
    expect(rewritePath("/api/v2/me", {})).toBe("/v2/me");
    expect(rewritePath("/v2/ee/me", {})).toBe("/v2/me");
    expect(rewritePath("/v2/schedules/reccuring", {})).toBe("/v2/schedules/recurring");
    expect(rewritePath("/api/health", {})).toBeNull();
    expect(rewritePath("/v2/health", { REWRITE_API_V2_PREFIX: "0" })).toBe("/health");
    expect(rewritePath("/api/v2/me", { REWRITE_API_V2_PREFIX: "0" })).toBeNull();
  });

  it("strips API_GLOBAL_PREFIX before routing", () => {
    expect(resolveInnerPath("/api/v2/me", { API_GLOBAL_PREFIX: "api" })).toEqual({ path: "/v2/me" });
    expect(resolveInnerPath("/api/health", { API_GLOBAL_PREFIX: "api" })).toEqual({ path: "/health" });
    expect(resolveInnerPath("/v2/me", { API_GLOBAL_PREFIX: "/api" })).toBeNull();
    expect(resolveInnerPath("/api/health", {})).toEqual({ path: "/api/health" });
  });
});

describe("metadata route table", () => {
  it("builds the only mounted route from AppController metadata", () => {
    const table = buildRouteTable(modules);

    expect(table).toHaveLength(1);
    expect(table[0].controllerClass).toBe(AppController);
    expect(table[0]).toMatchObject({
      moduleKey: "health",
      methodName: "getHealth",
      method: "GET",
      path: "/health",
      version: { kind: "neutral" },
      status: 200,
      headers: [],
      params: [],
      responsePassthrough: false,
    });
    expect(table[0].redirect).toBeUndefined();
    expect(Reflect.getMetadata(PATH_METADATA, AppController)).toBe("/");
  });

  it("reads path, method, version, status, header, redirect and parameter decorators", () => {
    const table = buildRouteTable([probeModule]);
    const probe = table.find((record) => record.methodName === "probe");
    expect(probe).toMatchObject({
      method: "GET",
      path: "/probe/:id",
      version: { kind: "versions", values: ["2024-06-14"] },
      status: 202,
      headers: [{ name: "x-probe", value: "yes" }],
    });
    const params = new Map((probe?.params ?? []).map((param) => [param.index, param]));
    expect(params.get(0)).toMatchObject({ source: "headers", data: "x-client" });
    expect(params.get(1)).toMatchObject({ source: "param", data: "id" });

    const create = table.find((record) => record.methodName === "create");
    expect(create).toMatchObject({
      method: "POST",
      path: "/probe",
      status: 201,
      version: { kind: "versions", values: ["2024-04-15", "2024-06-14"] },
    });

    const moved = table.find((record) => record.methodName === "moved");
    expect(moved?.redirect).toEqual({ statusCode: 308, url: "https://example.test" });
  });
});

async function seedUsers(db: Awaited<ReturnType<Miniflare["getD1Database"]>>): Promise<void> {
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (id, uuid, username, name, email, emailVerified, timeZone, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(9001, "9001-uuid", "worker-user", "Worker User", "worker@calflare.test", null, "Europe/Paris", 0),
    db
      .prepare(
        `INSERT INTO users (id, uuid, username, name, email, emailVerified, timeZone, locked)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(9002, "9002-uuid", "locked-user", "Locked User", "locked@calflare.test", null, "Europe/Paris", 1),
  ]);
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

describe("api v2 Worker host in workerd", () => {
  let directory: string;
  let mf: Miniflare;
  let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
  let workerSource: string;

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "calflare-api-v2-worker-"));
    const persistTo = join(directory, "state");
    // The migration CLI derives the local D1 identity from the web Worker's binding, so the test
    // Worker must reuse that identity to read the same database.
    const { database } = await migrateD1({ persistTo });
    workerSource = await buildWorker(join(directory, "bundle"));
    mf = createTestWorker({ workerSource, database, persistTo });
    db = await mf.getD1Database("DB");
    await seedUsers(db);
  }, 300_000);

  afterAll(async () => {
    await mf?.dispose();
    if (directory) await rm(directory, { recursive: true, force: true });
  });

  it("serves the source health controller under every public prefix", async () => {
    for (const path of [
      "/health",
      "/v2/health",
      "/api/v2/health",
      "/health/",
      "/v2/health/",
      "/api/v2/health/",
    ]) {
      const response = await mf.dispatchFetch(`https://api.calflare.test${path}`);

      expect(response.status, path).toBe(200);
      expect(await response.text(), path).toBe("OK");
      expect(response.headers.get("content-type"), path).toBe("text/html; charset=utf-8");
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

  it("rewrites an unknown public route before producing the 404", async () => {
    const response = await mf.dispatchFetch("https://api.calflare.test/api/v2/me");
    const body = (await response.json()) as { error: { code: string; message: string } };

    expect(response.status).toBe(404);
    expect(body.error.code).toBe("NotFoundException");
    expect(body.error.message).toBe("Cannot GET /v2/me");
  });

  it("answers the source CORS preflight with the exact options", async () => {
    const response = await mf.dispatchFetch("https://api.calflare.test/v2/me", {
      method: "OPTIONS",
      headers: {
        Origin: "https://client.calflare.test",
        "Access-Control-Request-Method": "GET",
        "Access-Control-Request-Headers": "authorization,cal-api-version",
      },
    });

    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-methods")).toBe(
      "GET,PATCH,DELETE,HEAD,POST,PUT,OPTIONS"
    );
    expect(response.headers.get("access-control-allow-headers")).toBe(
      "x-cal-client-id,x-cal-secret-key,x-cal-platform-embed,cal-api-version,Accept,Authorization,Content-Type,Origin"
    );
    expect(response.headers.get("access-control-max-age")).toBe("86400");
  });

  it("redirects the docs paths to DOCS_URL", async () => {
    const app = createApiApp({
      table: buildRouteTable(modules),
      scopeFor: () => ({ controllers: new Map([[AppController, new AppController()]]) }),
    });
    for (const path of ["/v2/docs", "/docs"]) {
      const response = await app.fetch(new Request(`https://api.calflare.test${path}`), {
        DOCS_URL: "https://docs.calflare.test/platform",
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("location")).toBe("https://docs.calflare.test/platform");
    }
  });

  it("keeps the built bundle under the 64 MiB uncompressed budget", () => {
    expect(Buffer.byteLength(workerSource)).toBeLessThan(64 * 1024 * 1024);
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
