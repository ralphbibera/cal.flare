import { execFileSync } from "node:child_process";
import { readdir } from "node:fs/promises";
import path from "node:path";
import { cloudflare } from "@cloudflare/vite-plugin";
import { staticAssetsAdapter } from "@vinext/cloudflare/cache/static-assets-adapter";
import type { TItem } from "nextra";
import { compileMdx } from "nextra/compile";
import { convertToPageMap } from "nextra/page-map";
import vinext from "vinext";
import type { Plugin } from "vite";
import { defineConfig } from "vite";

const root = import.meta.dirname;
const manifestId = "\0virtual:docs";

function docsContent(): Plugin {
  const compiled = new Map<string, string>();
  return {
    // Vinext recognizes custom MDX compilers by this plugin name.
    name: "mdx",
    enforce: "pre",
    resolveId(source) {
      if (source === "virtual:docs") return manifestId;
      if (source === "next-mdx-import-source-file") return path.join(root, "mdx-components.ts");
    },
    async load(id) {
      if (id !== manifestId) return;
      const files = (await readdir(path.join(root, "content"), { recursive: true }))
        .filter((file) => /(?:\.mdx?$|(?:^|\/)_meta\.[jt]sx?$)/.test(file))
        .map((file) => `content/${file}`)
        .sort((a, b) => a.localeCompare(b));
      const { pageMap, mdxPages } = convertToPageMap({ filePaths: files });
      const imports: string[] = [];
      function serialize(items: TItem[]): string {
        return `[${items
          .map((item) => {
            if ("children" in item) {
              return `{name:${JSON.stringify(item.name)},route:${JSON.stringify(item.route)},children:${serialize(item.children)}}`;
            }
            const name = `entry${imports.length}`;
            const file = "__metaPath" in item ? item.__metaPath : item.__pagePath;
            imports.push(
              `import ${"__metaPath" in item ? name : `{metadata as ${name}}`} from ${JSON.stringify(path.join(root, file))};`
            );
            return "__metaPath" in item
              ? `{data:${name}}`
              : `{name:${JSON.stringify(item.name)},route:${JSON.stringify(item.route)},frontMatter:${name}}`;
          })
          .join(",")} ]`;
      }
      const map = serialize(pageMap);
      const pages = Object.entries(mdxPages).map(
        ([route, file]) =>
          `${JSON.stringify(route)}:()=>import(${JSON.stringify(path.join(root, "content", file))})`
      );
      for (const file of files) this.addWatchFile(path.join(root, file));
      return `import {normalizePageMap} from "nextra/page-map";
import {notFound} from "next/navigation";
${imports.join("\n")}
const pages = {${pages.join(",")}};
export async function getPageMap() { return normalizePageMap(${map}); }
export function generateStaticParamsFor(key) {
  return async () => Object.keys(pages).map(route => ({[key]:route ? route.split("/") : []}));
}
export async function importPage(segments = []) {
  const route = decodeURIComponent(segments.join("/"));
  const load = Object.hasOwn(pages, route) && pages[route];
  if (!load) notFound();
  return load();
}`;
    },
    async transform(source, id) {
      const file = id.split("?")[0];
      if (
        this.environment.config.consumer === "client" &&
        file.endsWith("/nextra/dist/server/constants.js")
      ) {
        // Nextra shares its URL regex with clients; webpack normally supplies process.cwd.
        return { code: source.replace("const CWD = process.cwd();", 'const CWD = "/";'), map: null };
      }
      if (!file.startsWith(path.join(root, "content") + path.sep) || !/\.mdx?$/.test(file)) return;
      const cacheKey = `${file}:${source}`;
      let code = compiled.get(cacheKey);
      if (!code) {
        const timestamp = execFileSync("git", ["log", "-1", "--format=%ct", "--", file], {
          cwd: root,
          encoding: "utf8",
        }).trim();
        code = await compileMdx(source, {
          filePath: file,
          staticImage: true,
          search: { codeblocks: false },
          lastCommitTime: timestamp ? Number(timestamp) * 1000 : undefined,
          mdxOptions: { outputFormat: "program", providerImportSource: "next-mdx-import-source-file" },
        });
        compiled.set(cacheKey, code);
      }
      return { code, map: null };
    },
    handleHotUpdate() {
      compiled.clear();
    },
  };
}

export default defineConfig({
  envPrefix: [],
  environments: {
    rsc: { build: { rolldownOptions: { output: { entryFileNames: "[name].js" } } } },
    ssr: { build: { rolldownOptions: { output: { entryFileNames: "[name].js" } } } },
  },
  define: {
    "process.env.NEXTRA_DEFAULT_LOCALE": JSON.stringify(""),
    "process.env.NEXTRA_SHOULD_ADD_LOCALE_TO_LINKS": JSON.stringify("false"),
  },
  plugins: [
    docsContent(),
    vinext({ cache: { cdn: staticAssetsAdapter() }, prerender: { routes: "*", concurrency: 1 } }),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      remoteBindings: false,
      tunnel: false,
    }),
  ],
});
