import { withSentry } from "@sentry/cloudflare";
import handler from "vinext/server/fetch-handler";
import type { SentryEnvironment } from "../sentry.server.config";
import { getSentryOptions } from "../sentry.server.config";

type WorkerEnvironment = SentryEnvironment & NonNullable<Parameters<typeof handler.fetch>[1]>;

export * from "vinext/server/fetch-handler";

export default withSentry<WorkerEnvironment>((env) => getSentryOptions(env), { ...handler });
