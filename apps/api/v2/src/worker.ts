import { ERROR_STATUS } from "@calcom/platform-constants";
import { withD1Database } from "@calcom/prisma/d1";
import type { D1Database, ExecutionContext } from "@cloudflare/workers-types";
import { Hono } from "hono";

type WorkerEnvironment = {
  DB: D1Database;
};

const app = new Hono<{ Bindings: WorkerEnvironment }>();

// The source health controller returns the string "OK", which Nest's Express adapter sends as HTML.
app.get("/v2/health", (context) => context.html("OK"));
app.get("/api/v2/health", (context) => context.html("OK"));

// Temporary Nest-shaped 404 until the metadata host owns the filter chain.
app.notFound((context) => {
  const url = new URL(context.req.url);
  const path = `${url.pathname}${url.search}`;
  const message = `Cannot ${context.req.method} ${path}`;
  return context.json(
    {
      status: ERROR_STATUS,
      timestamp: new Date().toISOString(),
      path,
      error: {
        code: "NotFoundException",
        message,
        details: { message, error: "Not Found", statusCode: 404 },
      },
    },
    404
  );
});

export default {
  fetch(request: Request, env: WorkerEnvironment, ctx: ExecutionContext): Response | Promise<Response> {
    if (!env?.DB) throw new Error("Worker bindings are required");
    return withD1Database(env, () => app.fetch(request, env, ctx));
  },
};

// biome-ignore lint/style/noRestrictedImports: the web Worker binds this Durable Object class to calflare-api-v2
export { RuntimeState } from "@calcom/lib/RuntimeState";
