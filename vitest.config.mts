import path from "node:path";
import process from "node:process";
import react from "@vitejs/plugin-react";
import { loadEnv } from "vite";
import { defineConfig } from "vitest/config";
import { prismaWasmPlugin } from "./packages/prisma/tooling/vite-wasm-plugin.mjs";
import projects from "./vitest.workspace";

const env = loadEnv("", process.cwd(), "");
for (const [key, value] of Object.entries(env)) {
  if (process.env[key] === undefined) {
    process.env[key] = value;
  }
}

// Server-side source imports are intentional in the inherited test harness.
process.env.INTEGRATION_TEST_MODE = "true";

export default defineConfig({
  plugins: [react(), prismaWasmPlugin()],
  resolve: {
    alias: [
      {
        find: /^@prisma\/client$/,
        replacement: path.resolve(__dirname, "packages/prisma/client/index.ts"),
      },
      // Mock generated files that may not exist in CI (must come before general aliases)
      {
        find: "@calcom/web/public/app-store/svg-hashes.json",
        replacement: path.resolve(__dirname, "vitest-mocks/svg-hashes.json"),
      },
      {
        find: /^\.\/tailwind\.generated\.css\?inline$/,
        replacement: path.resolve(__dirname, "vitest-mocks/tailwind.generated.css"),
      },
      // Alias Node.js built-ins for jsdom environment
      { find: "crypto", replacement: "node:crypto" },
      // API v1 path alias
      { find: "~", replacement: path.resolve(__dirname, "apps/api/v1") },
      // apps/web path aliases
      { find: "@lib", replacement: path.resolve(__dirname, "apps/web/lib") },
      { find: "app", replacement: path.resolve(__dirname, "apps/web/app") },
      { find: "@calcom/web", replacement: path.resolve(__dirname, "apps/web") },
      // Platform packages that need to be resolved from source in CI
      {
        find: "@calcom/platform-constants",
        replacement: path.resolve(__dirname, "packages/platform/constants/index.ts"),
      },
    ],
  },
  test: {
    globals: true,
    silent: true,
    environment: "jsdom",
    projects,
    pool: "forks",
    globalSetup: ["./packages/prisma/tooling/d1-template-global-setup.mts"],
    server: {
      deps: {
        inline: [/@calcom\/.*/, /prismock/],
      },
    },
    coverage: {
      provider: "v8",
    },
    passWithNoTests: true,
    testTimeout: 500000,
    // D1 setup hooks boot workerd and apply every migration, which can exceed short hook
    // timeouts when CI runs many of these files in parallel.
    hookTimeout: 120000,
  },
});

setEnvVariablesThatAreUsedBeforeSetup();

function setEnvVariablesThatAreUsedBeforeSetup() {
  // We can't set it during tests because it is used as soon as _metadata.ts is imported which happens before tests start running
  process.env.DAILY_API_KEY = "MOCK_DAILY_API_KEY";
  // With same env variable, we can test both non org and org booking scenarios
  process.env.NEXT_PUBLIC_WEBAPP_URL = "http://app.cal.local:3000";
  process.env.CALCOM_SERVICE_ACCOUNT_ENCRYPTION_KEY = "UNIT_TEST_ENCRYPTION_KEY";
  process.env.STRIPE_PRIVATE_KEY = process.env.STRIPE_PRIVATE_KEY || "sk_test_dummy_unit_test_key";
}
