import * as Sentry from "@sentry/cloudflare";

export function register(): void {
  Sentry.setAsyncLocalStorageAsyncContextStrategy();
}
