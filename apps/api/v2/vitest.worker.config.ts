import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vitest/config";

const PRISMA_WASM_PREFIX = "\0prisma-query-compiler:";
const APP_STORE_ALIAS = "@calcom/platform-libraries/app-store";
const APP_STORE_WORKER_MODULE = "src/worker/platform-libraries-app-store.ts";
const appRoot = fileURLToPath(new URL(".", import.meta.url));

export interface WorkerResolveAlias {
  find: string | RegExp;
  replacement: string;
}

// Prisma's D1 client imports its query compiler with Wrangler's `?module` suffix. Neither Vitest nor
// plain Vite understands it, so the runner and the workerd bundle both compile the bytes directly.
export function prismaQueryCompiler() {
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

/** Worker builds resolve the filter's calendar errors to source so @Catch matches what it throws. */
export function workerResolveAliases(appRoot: string): WorkerResolveAlias[] {
  const tsconfig = JSON.parse(readFileSync(join(appRoot, "tsconfig.json"), "utf8")) as {
    compilerOptions: { paths: Record<string, string[]> };
  };

  return [
    {
      find: new RegExp(`^${APP_STORE_ALIAS}$`),
      replacement: join(appRoot, APP_STORE_WORKER_MODULE),
    },
    ...Object.entries(tsconfig.compilerOptions.paths)
      .filter(([find]) => find !== APP_STORE_ALIAS)
      .map(([find, [target]]) => ({
        find: new RegExp(`^${find.replace("*", "(.*)")}$`),
        replacement: join(appRoot, target.replace("*", "$1")),
      })),
  ];
}

export default defineConfig({
  plugins: [prismaQueryCompiler()],
  resolve: {
    alias: workerResolveAliases(appRoot),
  },
  test: {
    name: "@calcom/api-v2-worker",
    include: ["src/worker/**/*.worker-test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
