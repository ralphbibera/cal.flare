import { builtinModules } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const webRoot = fileURLToPath(new URL("../..", import.meta.url));
const nodeBuiltins = new Set(builtinModules);

export async function buildScheduleWorker(outDir: string) {
  await build({
    configFile: false,
    root: webRoot,
    publicDir: false,
    logLevel: "error",
    resolve: {
      tsconfigPaths: true,
      conditions: ["workerd", "worker", "import", "default"],
      noExternal: true,
    },
    define: { "process.env.NODE_ENV": '"production"', __dirname: '"/"', __filename: '"/worker.js"' },
    oxc: { jsx: { runtime: "automatic" } },
    plugins: [
      {
        name: "schedule-worker-harness",
        enforce: "pre",
        resolveId(source) {
          if (source === "virtual:calflare-static-assets") return "\0static-assets";
          if (source === "vinext/server/fetch-handler") {
            return fileURLToPath(new URL("./recording-handler.ts", import.meta.url));
          }
          if (source.startsWith("cloudflare:") || source.startsWith("node:")) {
            return { id: source, external: true };
          }
          if (nodeBuiltins.has(source)) return { id: `node:${source}`, external: true };
        },
        load(id) {
          if (id === "\0static-assets") return "export default {};";
        },
      },
    ],
    build: {
      ssr: fileURLToPath(new URL("../index.ts", import.meta.url)),
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rolldownOptions: {
        output: {
          entryFileNames: "worker.js",
          // CommonJS dependencies call require() for Node builtins, which ESM Workers do not provide.
          banner: 'import { createRequire } from "node:module"; const require = createRequire("/");',
        },
      },
    },
    ssr: { noExternal: true, target: "webworker" },
  });
}
