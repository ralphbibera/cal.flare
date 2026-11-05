import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";

// Only Node tooling imports this plugin. Workers use Cloudflare's native CompiledWasm loader.
/** @returns {import("vite").Plugin} */
export function prismaWasmPlugin() {
  let building = false;
  return {
    name: "prisma-wasm-for-node-tools",
    enforce: "pre",
    configResolved(config) {
      building = config.command === "build";
    },
    load(id) {
      if (!id.endsWith(".wasm?module")) return;
      const filename = id.slice(0, -"?module".length);
      const asset = building
        ? `import.meta.ROLLUP_FILE_URL_${this.emitFile({
            type: "asset",
            name: basename(filename),
            source: readFileSync(filename),
          })}`
        : JSON.stringify(pathToFileURL(filename).href);
      return `import { readFileSync } from "node:fs";
export default new WebAssembly.Module(readFileSync(new URL(${asset})));`;
    },
  };
}
