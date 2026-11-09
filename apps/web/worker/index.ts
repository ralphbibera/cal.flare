import { EmailMessage } from "cloudflare:email";
import process from "node:process";
import manifest from "virtual:calflare-static-assets";
import { withAuthRequestEnvironment } from "@calcom/features/auth/lib/request-context";
import { withCloudflareEmail } from "@calcom/lib/cloudflareEmailTransport";
import { WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { withD1Database } from "@calcom/prisma/d1";
import { withSentry } from "@sentry/cloudflare";
import handler from "vinext/server/fetch-handler";
import type { SentryEnvironment } from "../sentry.server.config";
import { getSentryOptions } from "../sentry.server.config";
import { handleE2eD1 } from "./e2e-d1";
import type { ScheduleEnvironment } from "./schedules";
import { dispatchSchedules } from "./schedules";
import { frameStaticAsset, withStaticAssets } from "./static-assets";

type WorkerEnvironment = SentryEnvironment &
  NonNullable<Parameters<typeof handler.fetch>[1]> &
  Env &
  ScheduleEnvironment;

async function serve(
  request: Parameters<typeof handler.fetch>[0],
  env: WorkerEnvironment,
  ctx: Parameters<typeof handler.fetch>[2]
) {
  const e2eD1Response = await handleE2eD1(request, env);
  if (e2eD1Response) return e2eD1Response;
  return withCloudflareEmail(
    async ({ from, to, raw }) => {
      if (!env.EMAIL) {
        throw new ErrorWithCode(
          ErrorCode.InternalServerError,
          "EMAIL binding is required for email delivery"
        );
      }
      await env.EMAIL.send(
        new EmailMessage(
          from,
          to,
          new ReadableStream({
            start(controller) {
              controller.enqueue(raw);
              controller.close();
            },
          })
        )
      );
    },
    () =>
      withD1Database(env, () =>
        withAuthRequestEnvironment(
          {
            DB: env.DB,
            NEXTAUTH_SECRET: env.NEXTAUTH_SECRET,
            baseURL: process.env.NEXTAUTH_URL || WEBAPP_URL,
            webappURL: WEBAPP_URL,
            NEXTAUTH_COOKIE_DOMAIN: process.env.NEXTAUTH_COOKIE_DOMAIN,
            credentialPolicy: {
              encryptionKey: process.env.CALENDSO_ENCRYPTION_KEY,
              isDevelopment: process.env.NODE_ENV === "development",
              isE2E: Boolean(process.env.NEXT_PUBLIC_IS_E2E),
              rateLimit: process.env.UNKEY_ROOT_KEY ? "enabled" : "disabled",
            },
          },
          () => handler.fetch(request, withStaticAssets(env, manifest), ctx)
        )
      ),
    (promise) => ctx.waitUntil(promise)
  );
}

const instrumented = withSentry<WorkerEnvironment>((env) => getSentryOptions(env), {
  ...handler,
  fetch(
    request: Parameters<typeof handler.fetch>[0],
    env: WorkerEnvironment,
    ctx: Parameters<typeof handler.fetch>[2]
  ) {
    if (!env) throw new Error("Worker bindings are required");
    return serve(request, env, ctx);
  },
  scheduled(controller: ScheduledController, env: WorkerEnvironment, ctx: ExecutionContext) {
    ctx.waitUntil(dispatchSchedules(controller, env, (request) => serve(request, env, ctx)));
  },
});

export default {
  ...instrumented,
  async fetch(
    request: Parameters<typeof handler.fetch>[0],
    env: WorkerEnvironment,
    ctx: Parameters<typeof handler.fetch>[2]
  ) {
    if (!env || !ctx || !instrumented.fetch) throw new Error("Worker execution context is required");
    return frameStaticAsset(await instrumented.fetch(request, env, ctx), manifest);
  },
};

export * from "vinext/server/fetch-handler";
