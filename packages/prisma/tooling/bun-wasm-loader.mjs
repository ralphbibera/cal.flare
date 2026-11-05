import { plugin } from "bun";

plugin({
  name: "prisma-wasm-for-bun-tools",
  setup(build) {
    build.onLoad({ filter: /\.wasm\?module$/ }, ({ path }) => ({
      loader: "js",
      contents: `import { readFileSync } from "node:fs";
export default new WebAssembly.Module(readFileSync(${JSON.stringify(path.replace(/\?module$/, ""))}));`,
    }));
  },
});
