import process from "node:process";
import { createWorkersResponseStoreSelfContainedConfig } from "@vinext/cloudflare/cache/config";
import { bindings, defineConfig, defineWorker, triggers } from "cf/config";

const cache = await createWorkersResponseStoreSelfContainedConfig({
  worker: "calflare-web",
  bucket: "calflare-web-response-store-cache-bodies",
});

const cspPolicy = process.env.CSP_POLICY;

export default defineConfig({
  worker: defineWorker({
    ...cache,
    name: "calflare-web",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-11-04",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    // One message per invocation keeps the source calendars concurrency limit of 10 until DO admission.
    triggers: [
      triggers.scheduled({ schedule: "* * * * *" }),
      triggers.queue({ name: "calflare-jobs", maxBatchSize: 1, maxConcurrency: 10, maxRetries: 10 }),
    ],
    env: {
      ...cache.env,
      NEXTAUTH_SECRET: bindings.secret(),
      CALENDSO_ENCRYPTION_KEY: bindings.secret(),
      CSP_POLICY: cspPolicy ? bindings.text(cspPolicy) : undefined,
      ASSETS: bindings.assets(),
      DB: bindings.d1({ name: "calflare" }),
      EMAIL: bindings.sendEmail(),
      API_V2: bindings.worker({ worker: "calflare-api-v2" }),
      JOBS: bindings.queue({ name: "calflare-jobs" }),
      RUNTIME_STATE: bindings.durableObject({ worker: "calflare-api-v2", exportName: "RuntimeState" }),
    },
  }),
});
