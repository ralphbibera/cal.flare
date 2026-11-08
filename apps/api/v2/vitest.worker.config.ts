import { readFileSync } from "node:fs";
import { fileURLToPath, pathToFileURL } from "node:url";
import { defineConfig } from "vitest/config";

const PRISMA_WASM_PREFIX = "\0prisma-query-compiler:";

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

export default defineConfig({
  plugins: [prismaQueryCompiler()],
  resolve: {
    alias: { "@": fileURLToPath(new URL("./src", import.meta.url)) },
  },
  test: {
    name: "@calcom/api-v2-worker",
    include: ["src/worker/index.worker-test.ts"],
    environment: "node",
    pool: "forks",
    testTimeout: 300_000,
    hookTimeout: 300_000,
  },
});
