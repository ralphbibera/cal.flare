import * as Sentry from "@sentry/cloudflare";
import type { Instrumentation } from "next";

export async function register(): Promise<void> {
  const { register: registerWorkerInstrumentation } = await import("./sentry.edge.config");
  registerWorkerInstrumentation();
}

export const onRequestError: Instrumentation.onRequestError = (err, _request, context) => {
  if (process.env.NODE_ENV !== "production") return;

  Sentry.withScope((scope) => {
    scope.setTag("errorSource", context.routeType === "proxy" ? "edge" : "server");
    scope.setContext("nextjs", {
      routerKind: context.routerKind,
      routePath: context.routePath,
      routeType: context.routeType,
    });
    Sentry.captureException(err, { mechanism: { type: "auto.function.nextjs", handled: false } });
  });
};
