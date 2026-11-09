import process from "node:process";
import { createWorkersResponseStoreSelfContainedConfig } from "@vinext/cloudflare/cache/config";
import { bindings, defineConfig, defineWorker, exports, triggers } from "cf/config";
import {
  DEAD_LETTER_QUEUE,
  type JobQueueName,
  QUEUES,
  queueName,
} from "../../packages/features/tasker/queue/queues.ts";

const cache = await createWorkersResponseStoreSelfContainedConfig({
  worker: "calflare-web",
  bucket: "calflare-web-response-store-cache-bodies",
});

const cspPolicy = process.env.CSP_POLICY;

const jobQueues = (Object.keys(QUEUES) as JobQueueName[]).map((name) => {
  const queue = QUEUES[name];
  return triggers.queue({
    name: queueName(name),
    deadLetterQueue: DEAD_LETTER_QUEUE,
    maxBatchSize: 1,
    maxConcurrency: queue.maxConcurrency,
    maxRetries: queue.maxRetries,
    visibilityTimeoutMs: queue.visibilityTimeoutMs,
  });
});

export default defineConfig({
  worker: defineWorker({
    ...cache,
    name: "calflare-web",
    entrypoint: "./worker/index.ts",
    compatibilityDate: "2026-11-04",
    compatibilityFlags: ["nodejs_compat"],
    exports: {
      ...cache.exports,
      RuntimeState: exports.durableObject({ storage: "sqlite" }),
    },
    workersDev: false,
    previewUrls: false,
    assets: {
      htmlHandling: "none",
      notFoundHandling: "none",
      runWorkerFirst: ["/*", "!/_next/static/*", "!/*/_next/static/*"],
    },
    triggers: [triggers.scheduled({ schedule: "* * * * *" }), ...jobQueues],
    env: {
      ...cache.env,
      NEXTAUTH_SECRET: bindings.secret(),
      CALENDSO_ENCRYPTION_KEY: bindings.secret(),
      CSP_POLICY: cspPolicy ? bindings.text(cspPolicy) : undefined,
      ASSETS: bindings.assets(),
      DB: bindings.d1({ name: "calflare" }),
      EMAIL: bindings.sendEmail(),
      JOBS_WEBHOOKS: bindings.queue({ name: queueName("webhooks") }),
      JOBS_CALENDARS: bindings.queue({ name: queueName("calendars") }),
      JOBS_NOTIFICATIONS: bindings.queue({ name: queueName("notifications") }),
      RUNTIME_STATE: bindings.durableObject({ worker: "calflare-web", exportName: "RuntimeState" }),
    },
  }),
});
