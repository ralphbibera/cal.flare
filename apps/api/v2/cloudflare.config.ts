import { bindings, defineConfig, defineWorker, exports } from "cf/config";

export default defineConfig({
  worker: defineWorker({
    name: "calflare-api-v2",
    entrypoint: "./src/worker.ts",
    compatibilityDate: "2026-11-04",
    compatibilityFlags: ["nodejs_compat"],
    workersDev: false,
    previewUrls: false,
    exports: {
      RuntimeState: exports.durableObject({ storage: "sqlite" }),
    },
    env: {
      DB: bindings.d1({ name: "calflare" }),
    },
  }),
});
