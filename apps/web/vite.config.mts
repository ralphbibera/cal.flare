import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { cloudflare } from "@cloudflare/vite-plugin";
import { responseStoreAdapter } from "@vinext/cloudflare/cache/response-store-adapter";
import vinext from "vinext";
import type { Plugin } from "vite";
import { defineConfig } from "vite";
import { patchCssModules } from "vite-css-modules";
import { bundleAnalysis } from "./scripts/bundle-analysis";
import { clientProcessPolyfill, publicBuildEnvironment } from "./scripts/client-process";
import { staticAssets } from "./scripts/static-assets";

function publicEnvironment(): Plugin {
  return {
    name: "calflare:public-environment",
    enforce: "post",
    configEnvironment(name, config) {
      if (name !== "client") return;
      config.define = Object.fromEntries(
        Object.entries(config.define ?? {}).filter(
          ([key]) =>
            !key.startsWith("process.env.NEXT_PUBLIC_") ||
            publicBuildEnvironment.has(key.slice("process.env.".length))
        )
      );
    },
  };
}

function i18nConfigInterop(): Plugin {
  const configPath = fileURLToPath(new URL("../../packages/i18n/next-i18next.config.js", import.meta.url));
  const facadeId = "\0calflare:i18n-config";
  return {
    name: "calflare:i18n-config-interop",
    enforce: "pre",
    resolveId(source) {
      if (source === "@calcom/i18n/next-i18next.config") return facadeId;
    },
    load(id) {
      if (id !== facadeId) return;
      return `import config from ${JSON.stringify(configPath)};
export default config;
export const { i18n, fallbackLng } = config;`;
    },
  };
}

function sentryRuntime(): Plugin {
  const configOwner = fileURLToPath(new URL("./instrumentation.ts", import.meta.url));
  return {
    name: "calflare:sentry-runtime",
    enforce: "pre",
    async resolveId(source) {
      if (source !== "@sentry/nextjs") return;
      const target =
        this.environment.config.consumer === "client" || this.environment.name === "ssr"
          ? "@sentry/react"
          : "@sentry/cloudflare";
      const resolved = await this.resolve(target, configOwner, { skipSelf: true });
      if (!resolved) throw new Error(`Unable to resolve ${target} from the web configuration`);
      return resolved;
    },
  };
}

function prismaClient(): Plugin {
  return {
    name: "calflare:prisma-client",
    enforce: "pre",
    resolveId(source) {
      if (source !== "@prisma/client" && source !== "@calcom/prisma/client") return;
      const browser = this.environment.config.consumer === "client";
      return fileURLToPath(
        new URL(
          browser
            ? "../../packages/prisma/generated/prisma/browser.ts"
            : "../../packages/prisma/client/index.ts",
          import.meta.url
        )
      );
    },
  };
}

export default defineConfig({
  envPrefix: [],
  environments: {
    rsc: { define: { __CALFLARE_EMAIL_RENDERER__: JSON.stringify("ssr") } },
    ssr: { build: { rolldownOptions: { output: { entryFileNames: "[name].js" } } } },
  },
  plugins: [
    staticAssets(),
    clientProcessPolyfill(),
    prismaClient(),
    bundleAnalysis(),
    i18nConfigInterop(),
    sentryRuntime(),
    patchCssModules({ exportMode: "default" }),
    vinext({ cache: responseStoreAdapter({ mode: "self-contained" }) }),
    cloudflare({
      viteEnvironment: { name: "rsc", childEnvironments: ["ssr"] },
      remoteBindings: false,
      tunnel: false,
    }),
    publicEnvironment(),
  ],
  css: {
    modules: {
      generateScopedName(name, filename) {
        const relativePath = path
          .relative(import.meta.dirname, filename.replace(/\?.*$/, ""))
          .replaceAll("\\", "/");
        return `_${name}_${createHash("sha256").update(relativePath).digest("hex").slice(0, 7)}`;
      },
    },
  },
  build: { sourcemap: true },
});
