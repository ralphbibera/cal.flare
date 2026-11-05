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
import { staticAssets } from "./scripts/static-assets";

const publicBuildEnvironment = new Set([
  "NEXT_PUBLIC_API_HITPAY_PRODUCTION",
  "NEXT_PUBLIC_API_HITPAY_SANDBOX",
  "NEXT_PUBLIC_API_V2_URL",
  "NEXT_PUBLIC_APP_NAME",
  "NEXT_PUBLIC_AVAILABILITY_SCHEDULE_INTERVAL",
  "NEXT_PUBLIC_AXIOM_INGEST_ENDPOINT",
  "NEXT_PUBLIC_BODY_SCRIPTS",
  "NEXT_PUBLIC_BOOKER_NUMBER_OF_DAYS_TO_LOAD",
  "NEXT_PUBLIC_CALCOM_VERSION",
  "NEXT_PUBLIC_CAL_AI_PHONE_NUMBER_MONTHLY_PRICE",
  "NEXT_PUBLIC_CLOUDFLARE_SITEKEY",
  "NEXT_PUBLIC_CLOUDFLARE_USE_TURNSTILE_IN_BOOKER",
  "NEXT_PUBLIC_COMPANY_NAME",
  "NEXT_PUBLIC_DISABLE_SIGNUP",
  "NEXT_PUBLIC_DUB_PROGRAM_ID",
  "NEXT_PUBLIC_EMBED_FINGER_PRINT",
  "NEXT_PUBLIC_EMBED_LIB_URL",
  "NEXT_PUBLIC_EMBED_VERSION",
  "NEXT_PUBLIC_ENABLE_PROFILE_SWITCHER",
  "NEXT_PUBLIC_FORMBRICKS_ENVIRONMENT_ID",
  "NEXT_PUBLIC_FORMBRICKS_HOST_URL",
  "NEXT_PUBLIC_GTM_ID",
  "NEXT_PUBLIC_HEAD_SCRIPTS",
  "NEXT_PUBLIC_HOSTED_CAL_FEATURES",
  "NEXT_PUBLIC_INVALIDATE_AVAILABLE_SLOTS_ON_BOOKING_FORM",
  "NEXT_PUBLIC_IS_E2E",
  "NEXT_PUBLIC_LOGGER_LEVEL",
  "NEXT_PUBLIC_MINUTES_TO_BOOK",
  "NEXT_PUBLIC_ORGANIZATIONS_SELF_SERVE_PRICE_NEW",
  "NEXT_PUBLIC_ORG_SELF_SERVE_ENABLED",
  "NEXT_PUBLIC_QUERY_AVAILABLE_SLOTS_INTERVAL_SECONDS",
  "NEXT_PUBLIC_QUERY_RESERVATION_INTERVAL_SECONDS",
  "NEXT_PUBLIC_QUERY_RESERVATION_STALE_TIME_SECONDS",
  "NEXT_PUBLIC_QUICK_AVAILABILITY_ROLLOUT",
  "NEXT_PUBLIC_SENDER_ID",
  "NEXT_PUBLIC_SENDGRID_SENDER_NAME",
  "NEXT_PUBLIC_SENTRY_DSN",
  "NEXT_PUBLIC_SENTRY_DSN_CLIENT",
  "NEXT_PUBLIC_SINGLE_ORG_MODE_ENABLED",
  "NEXT_PUBLIC_SINGLE_ORG_SLUG",
  "NEXT_PUBLIC_STRIPE_CREDITS_PRICE_ID",
  "NEXT_PUBLIC_STRIPE_PREMIUM_PLAN_PRICE_MONTHLY",
  "NEXT_PUBLIC_STRIPE_PREMIUM_PLAN_PRODUCT_ID",
  "NEXT_PUBLIC_STRIPE_PUBLIC_KEY",
  "NEXT_PUBLIC_STRIPE_TEAM_MONTHLY_PRICE_ID",
  "NEXT_PUBLIC_SUPPORT_MAIL_ADDRESS",
  "NEXT_PUBLIC_UNIT_TESTS",
  "NEXT_PUBLIC_VAPID_PUBLIC_KEY",
  "NEXT_PUBLIC_VERCEL_GIT_COMMIT_SHA",
  "NEXT_PUBLIC_VERCEL_URL",
  "NEXT_PUBLIC_VERCEL_USE_BOTID_IN_BOOKER",
  "NEXT_PUBLIC_WEBAPP_URL",
  "NEXT_PUBLIC_WEBSITE_PRIVACY_POLICY_URL",
  "NEXT_PUBLIC_WEBSITE_TERMS_URL",
  "NEXT_PUBLIC_WEBSITE_URL",
]);

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

function apiV2Transport(): Plugin {
  const nativeProxyPath = fileURLToPath(import.meta.resolve("vinext/config/config-matchers"));
  const transportPath = fileURLToPath(new URL("./worker/api-v2-transport.ts", import.meta.url));
  const nativeFetch = "upstreamResponse = await fetch(targetUrl.href, {";

  return {
    name: "calflare:api-v2-transport",
    enforce: "pre",
    transform(code, id) {
      if (this.environment.config.consumer !== "server" || id.split("?")[0] !== nativeProxyPath) return;
      if (code.split(nativeFetch).length !== 2) {
        throw new Error("vinext external rewrite transport changed. Review the API_V2 binding adapter.");
      }
      return {
        code:
          `import { fetchRewriteDestination } from ${JSON.stringify(transportPath)};\n` +
          code.replace(nativeFetch, "upstreamResponse = await fetchRewriteDestination(targetUrl.href, {"),
        map: null,
      };
    },
  };
}

function i18nConfigInterop(): Plugin {
  const configPath = fileURLToPath(new URL("../../packages/i18n/next-i18next.config.js", import.meta.url));
  const facadeId = "\0calflare:i18n-config";
  const localePathExpression = 'path.resolve(__dirname, "./locales")';
  return {
    name: "calflare:i18n-config-interop",
    enforce: "pre",
    resolveId(source) {
      if (source === "@calcom/i18n/next-i18next.config") return facadeId;
    },
    transform(code, id) {
      if (id.split("?")[0] !== configPath) return;
      if (code.split(localePathExpression).length !== 2) {
        throw new Error("i18n config localePath changed. Review its source-relative build boundary.");
      }
      return {
        code: code.replace(
          localePathExpression,
          JSON.stringify(path.join(path.dirname(configPath), "locales"))
        ),
        map: null,
      };
    },
    load(id) {
      if (id !== facadeId) return;
      return `import config from ${JSON.stringify(configPath)};
export default config;
export const { i18n, fallbackLng, reloadOnPrerender, localePath } = config;`;
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
      const browser = this.environment.name === "client" || this.environment.name === "ssr";
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
    ssr: { build: { rolldownOptions: { output: { entryFileNames: "[name].js" } } } },
  },
  plugins: [
    staticAssets(),
    prismaClient(),
    bundleAnalysis(),
    i18nConfigInterop(),
    sentryRuntime(),
    apiV2Transport(),
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
