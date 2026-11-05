const { dirname, resolve } = require("node:path");
const { transpileModule, ModuleKind, ScriptTarget } = require("typescript");

module.exports = {
  process(source, filename) {
    // Jest classifies .wasm as ESM before its file transformers can run.
    const loadableSource = source.replace(
      /import\((["'])([^"']+\.wasm)\?module\1\)/g,
      (_match, _quote, asset) =>
        `Promise.resolve({default: new WebAssembly.Module(require("node:fs").readFileSync(${JSON.stringify(resolve(dirname(filename), asset))}))})`
    );
    return {
      code: transpileModule(loadableSource, {
        fileName: filename,
        compilerOptions: {
          module: ModuleKind.CommonJS,
          target: ScriptTarget.ES2022,
          esModuleInterop: true,
        },
      }).outputText,
    };
  },
};
