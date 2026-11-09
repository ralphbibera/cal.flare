import process from "node:process";
import { createWorkersResponseStoreSelfContainedConfig } from "@vinext/cloudflare/cache/config";
import { bindings, defineConfig, defineWorker, triggers } from "cf/config";

const cache = await createWorkersResponseStoreSelfContainedConfig({
  worker: "calflare-web",
  bucket: "calflare-web-response-store-cache-bodies",
});

const isE2E = process.env.NEXT_PUBLIC_IS_E2E === "1";
// The e2e runner serves MailHog on the loopback interface, matching the upstream CI service.
const emailServerHost = process.env.EMAIL_SERVER_HOST ?? (isE2E ? "127.0.0.1" : undefined);
const emailServerPort = process.env.EMAIL_SERVER_PORT ?? (isE2E ? "1025" : undefined);
const emailFrom = process.env.EMAIL_FROM ?? (isE2E ? "notifications@example.com" : undefined);
const cspPolicy = process.env.CSP_POLICY ?? (isE2E ? "non-strict" : undefined);
const textBinding = (value: string | undefined) => (value ? bindings.text(value) : undefined);
const edgeConfig = process.env.EDGE_CONFIG;

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
      EDGE_CONFIG: edgeConfig ? bindings.kv({ id: edgeConfig }) : undefined,
      ASSETS: bindings.assets(),
      DB: bindings.d1({ name: "calflare" }),
      EMAIL: bindings.sendEmail(),
      EMAIL_SERVER_HOST: textBinding(emailServerHost),
      EMAIL_SERVER_PORT: textBinding(emailServerPort),
      EMAIL_FROM: textBinding(emailFrom),
      API_V2: bindings.worker({ worker: "calflare-api-v2" }),
      JOBS: bindings.queue({ name: "calflare-jobs" }),
      RUNTIME_STATE: bindings.durableObject({ worker: "calflare-api-v2", exportName: "RuntimeState" }),
    },
  }),
});
