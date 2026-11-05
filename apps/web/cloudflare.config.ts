import { createWorkersResponseStoreSelfContainedConfig } from "@vinext/cloudflare/cache/config";
import { bindings, defineConfig, defineWorker } from "cf/config";

const cache = await createWorkersResponseStoreSelfContainedConfig({
  worker: "calflare-web",
  bucket: "calflare-web-response-store-cache-bodies",
});

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
    env: {
      ...cache.env,
      NEXTAUTH_SECRET: bindings.secret(),
      ASSETS: bindings.assets(),
      DB: bindings.d1({ name: "calflare" }),
      API_V2: bindings.worker({ worker: "calflare-api-v2" }),
      JOBS: bindings.queue({ name: "calflare-jobs" }),
      RUNTIME_STATE: bindings.durableObject({ worker: "calflare-api-v2", exportName: "RuntimeState" }),
    },
  }),
});
