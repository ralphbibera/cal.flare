import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

export default defineConfig({
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
