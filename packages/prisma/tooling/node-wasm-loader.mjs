import { existsSync } from "node:fs";
import { registerHooks } from "node:module";
import { extname } from "node:path";

// Native Node tools need the extensionless imports retained by the source generators.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.endsWith(".wasm?module") && specifier.startsWith(".") && context.parentURL) {
      return { url: new URL(specifier, context.parentURL).href, shortCircuit: true };
    }
    try {
      return nextResolve(specifier, context);
    } catch (error) {
      if (
        !context.parentURL?.match(/\.[cm]?ts$/) ||
        !specifier.startsWith(".") ||
        extname(specifier) ||
        !(error instanceof Error) ||
        !("code" in error) ||
        typeof error.code !== "string" ||
        !["ERR_MODULE_NOT_FOUND", "ERR_UNSUPPORTED_DIR_IMPORT"].includes(error.code)
      ) {
        throw error;
      }
      for (const suffix of [".ts", "/index.ts"]) {
        const candidate = new URL(specifier + suffix, context.parentURL);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
      throw error;
    }
  },
  load(url, context, nextLoad) {
    if (!url.endsWith(".wasm?module")) return nextLoad(url, context);
    const asset = new URL(url);
    asset.search = "";
    return {
      format: "module",
      shortCircuit: true,
      source: `import { readFileSync } from "node:fs";
export default new WebAssembly.Module(readFileSync(new URL(${JSON.stringify(asset.href)})));`,
    };
  },
});
