import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./tests",
  outputDir: "../../test-results/docs",
  workers: 1,
  use: { baseURL: "http://127.0.0.1:4317", headless: true, trace: "retain-on-failure" },
  webServer: {
    command: "bun run start --host 127.0.0.1 --port 4317",
    url: "http://127.0.0.1:4317",
    reuseExistingServer: true,
  },
});
