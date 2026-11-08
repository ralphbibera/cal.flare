import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { build } from "vite";
import config from "../../cloudflare.config";
import { prismaQueryCompiler } from "../../vitest.worker.config";

const BUNDLE_HARD_LIMIT_BYTES: number = 64 * 1024 * 1024;
const BUNDLE_TARGET_BYTES: number = 40 * 1024 * 1024;
const STARTUP_HARD_LIMIT_MS = 1000;
const STARTUP_TARGET_MS = 900;
const MEMORY_LIMIT_BYTES: number = 128 * 1024 * 1024;
const STARTUP_SAMPLES = 20;
const FORBIDDEN_MODULE =
  /\/node_modules\/(?:ioredis|bull|passport|@nestjs\/platform-express|pg|winston|@sentry\/node|@sentry\/nestjs)\//;

const appRoot: string = process.cwd();
if (!existsSync(join(appRoot, "cloudflare.config.ts"))) {
  throw new Error("Run worker:budget from apps/api/v2");
}

interface WorkerBundle {
  readonly code: string;
  readonly bytes: number;
  readonly modules: readonly { readonly id: string; readonly bytes: number }[];
}

async function bundleWorker(): Promise<WorkerBundle> {
  const tsconfig = JSON.parse(readFileSync(join(appRoot, "tsconfig.json"), "utf8")) as {
    compilerOptions: { paths: Record<string, string[]> };
  };
  const alias = Object.entries(tsconfig.compilerOptions.paths).map(([find, [target]]) => ({
    find: new RegExp(`^${find.replace("*", "(.*)")}$`),
    replacement: join(appRoot, target.replace("*", "$1")),
  }));

  const result = await build({
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
      write: false,
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

  const output = Array.isArray(result) ? result[0] : result;
  if (!output || !("output" in output)) throw new Error("Vite did not return a Worker bundle");
  const chunk = output.output.find((item) => item.type === "chunk");
  if (!chunk || chunk.type !== "chunk") throw new Error("Vite returned no Worker chunk");
  return {
    code: chunk.code,
    bytes: Buffer.byteLength(chunk.code),
    modules: Object.entries(chunk.modules)
      .map(([id, module]) => ({ id, bytes: module.renderedLength }))
      .sort((left, right) => right.bytes - left.bytes),
  };
}

async function measureStartup(workerSource: string, iteration: number, persistTo: string): Promise<number> {
  const { worker } = config;
  const resourcePersistencePath = join(persistTo, `run-${iteration}`, "v3");
  await mkdir(resourcePersistencePath, { recursive: true });
  const mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath,
    workers: [
      {
        config: {
          name: worker.name,
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          env: { DB: { ...worker.env.DB, id: randomUUID() } },
          manifest: {
            mainModule: "worker.js",
            modules: { "worker.js": { type: "esm", contents: workerSource } },
          },
        },
      },
    ],
  });

  try {
    const started = performance.now();
    const response = await mf.dispatchFetch("https://api.calflare.test/v2/health");
    const elapsed = performance.now() - started;
    if (response.status !== 200) throw new Error(`Cold health check returned ${response.status}`);
    await response.text();
    return elapsed;
  } finally {
    await mf.dispose();
  }
}

function percentile(samples: readonly number[], fraction: number): number {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

async function main(): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), "calflare-api-v2-budget-"));
  try {
    const bundle = await bundleWorker();
    const startupSamples: number[] = [];
    for (let index = 0; index < STARTUP_SAMPLES; index++) {
      startupSamples.push(await measureStartup(bundle.code, index, join(directory, "startup")));
    }
    const p50 = percentile(startupSamples, 0.5);
    const p95 = percentile(startupSamples, 0.95);
    const forbidden = bundle.modules.filter((module) => FORBIDDEN_MODULE.test(module.id));
    const bundleExceeded = bundle.bytes > BUNDLE_TARGET_BYTES;
    const startupExceeded = p95 > STARTUP_TARGET_MS;

    const report = {
      generatedAt: new Date().toISOString(),
      bundle: {
        bytes: bundle.bytes,
        hardLimitBytes: BUNDLE_HARD_LIMIT_BYTES,
        targetBytes: BUNDLE_TARGET_BYTES,
        status: bundleExceeded ? "exceeded" : "ok",
      },
      startup: {
        samplesMs: startupSamples.map((sample) => Math.round(sample)),
        p50Ms: Math.round(p50),
        p95Ms: Math.round(p95),
        hardLimitMs: STARTUP_HARD_LIMIT_MS,
        targetMs: STARTUP_TARGET_MS,
        status: startupExceeded ? "exceeded" : "ok",
      },
      memory: {
        limitBytes: MEMORY_LIMIT_BYTES,
        status: "not-measurable-in-workerd",
      },
      forbiddenModules: forbidden.map((module) => module.id),
      topModules: bundle.modules.slice(0, 20),
    };

    console.log("API v2 Worker budget (design B1 section 9)");
    console.log(
      `bundle ${formatMiB(report.bundle.bytes)} / ${formatMiB(BUNDLE_TARGET_BYTES)} target, ${formatMiB(
        BUNDLE_HARD_LIMIT_BYTES
      )} hard: ${report.bundle.status}`
    );
    console.log(
      `startup p50 ${report.startup.p50Ms} ms, p95 ${report.startup.p95Ms} ms / ${STARTUP_TARGET_MS} ms target, ${STARTUP_HARD_LIMIT_MS} ms hard: ${report.startup.status}`
    );
    console.log(`memory ${formatMiB(MEMORY_LIMIT_BYTES)} limit: ${report.memory.status}`);
    console.log("top modules by rendered bytes:");
    for (const module of report.topModules) {
      console.log(`  ${String(module.bytes).padStart(9)}  ${module.id}`);
    }
    if (forbidden.length > 0) {
      console.log(`forbidden modules: ${forbidden.map((module) => module.id).join(", ")}`);
    }

    await mkdir(join(appRoot, "dist"), { recursive: true });
    await writeFile(join(appRoot, "dist", "worker-bundle.json"), `${JSON.stringify(report, null, 2)}\n`);

    if (bundleExceeded || startupExceeded || forbidden.length > 0) process.exitCode = 1;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
