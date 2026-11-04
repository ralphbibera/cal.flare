import type { CloudflareOptions } from "@sentry/cloudflare";

export interface SentryEnvironment {
  NEXT_PUBLIC_SENTRY_DSN?: string;
  SENTRY_DEBUG?: string;
  SENTRY_SAMPLE_RATE?: string;
  SENTRY_TRACES_SAMPLE_RATE?: string;
}

export function getSentryOptions(env: SentryEnvironment): CloudflareOptions {
  return {
    enabled: process.env.NODE_ENV === "production" && !!env.NEXT_PUBLIC_SENTRY_DSN,
    debug: !!env.SENTRY_DEBUG,
    dsn: env.NEXT_PUBLIC_SENTRY_DSN,
    sampleRate: parseFloat(env.SENTRY_SAMPLE_RATE ?? "1.0") || 1.0,
    tracesSampleRate: parseFloat(env.SENTRY_TRACES_SAMPLE_RATE ?? "0.0") || 0.0,
    beforeSend(event) {
      event.tags = { errorSource: "server", ...event.tags };
      return event;
    },
  };
}
