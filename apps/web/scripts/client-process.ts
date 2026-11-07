import process from "node:process";
import type { Plugin } from "vite";

/** Variables Next.js inlines for the browser at build time. */
export const publicBuildEnvironment = new Set([
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

export const CLIENT_PROCESS_ID = "\0calflare:client-process";

export function publicEnvironmentValues(env: Record<string, string | undefined> = process.env) {
  const values: Record<string, string> = {};
  for (const key of Array.from(publicBuildEnvironment)) {
    const value = env[key];
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/**
 * Browser builds have no Node `process` global. Vite replaces `node:process`
 * imports with an empty module, so code such as `process.env.DAILY_API_KEY`
 * throws when a server module is reachable from the client graph. Next.js
 * instead gives the browser a `process.env` containing only public variables,
 * which is what this shim reproduces.
 */
export function clientProcessPolyfill(): Plugin {
  return {
    name: "calflare:client-process",
    enforce: "pre",
    resolveId(source) {
      if (this.environment.config.consumer !== "client") return;
      if (source === "node:process" || source === "process") return CLIENT_PROCESS_ID;
    },
    load(id) {
      if (id !== CLIENT_PROCESS_ID) return;
      const env = {
        NODE_ENV: process.env.NODE_ENV ?? "production",
        ...publicEnvironmentValues(),
      };
      return `const env = ${JSON.stringify(env)};
const shim = {
  env,
  browser: true,
  title: "browser",
  platform: "browser",
  argv: [],
  version: "",
  versions: {},
  pid: 1,
  cwd: () => "/",
  nextTick: (callback, ...args) => queueMicrotask(() => callback(...args)),
  on: () => shim,
  once: () => shim,
  off: () => shim,
  addListener: () => shim,
  removeListener: () => shim,
  removeAllListeners: () => shim,
  emit: () => false,
  listeners: () => [],
  listenerCount: () => 0,
};
export { env };
export default shim;
`;
    },
  };
}
