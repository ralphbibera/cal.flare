import { EmailMessage } from "cloudflare:email";
import manifest from "virtual:calflare-static-assets";
import { withCloudflareEmail } from "@calcom/lib/cloudflareEmailTransport";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { withD1Database } from "@calcom/prisma/d1";
import { withSentry } from "@sentry/cloudflare";
import handler from "vinext/server/fetch-handler";
import type { SentryEnvironment } from "../sentry.server.config";
import { getSentryOptions } from "../sentry.server.config";
import { frameStaticAsset, withStaticAssets } from "./static-assets";

type WorkerEnvironment = SentryEnvironment & NonNullable<Parameters<typeof handler.fetch>[1]> & Env;

export * from "vinext/server/fetch-handler";

const instrumented = withSentry<WorkerEnvironment>((env) => getSentryOptions(env), {
  ...handler,
  fetch(
    request: Parameters<typeof handler.fetch>[0],
    env: WorkerEnvironment,
    ctx: Parameters<typeof handler.fetch>[2]
  ) {
    if (!env) throw new Error("Worker bindings are required");
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
      () => withD1Database(env, () => handler.fetch(request, withStaticAssets(env, manifest), ctx)),
      (promise) => ctx.waitUntil(promise)
    );
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
