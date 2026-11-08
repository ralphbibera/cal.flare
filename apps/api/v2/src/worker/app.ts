import {
  CAL_API_VERSION_HEADER,
  ERROR_STATUS,
  X_CAL_CLIENT_ID,
  X_CAL_PLATFORM_EMBED,
  X_CAL_SECRET_KEY,
} from "@calcom/platform-constants";
import type { D1Database } from "@cloudflare/workers-types";
import type { Context, Next } from "hono";
import { Hono } from "hono";
import { cors } from "hono/cors";
import { secureHeaders } from "hono/secure-headers";
import { executeRoute } from "./execution/execute-route";
import type { ModuleScope, RouteRecord } from "./metadata";
import { extractApiVersion, versionMatches } from "./metadata";

type ApiContext = Context<{ Bindings: ApiEnv }>;

const CORS_OPTIONS: Parameters<typeof cors>[0] = {
  origin: "*",
  allowMethods: ["GET", "PATCH", "DELETE", "HEAD", "POST", "PUT", "OPTIONS"],
  allowHeaders: [
    X_CAL_CLIENT_ID,
    X_CAL_SECRET_KEY,
    X_CAL_PLATFORM_EMBED,
    CAL_API_VERSION_HEADER,
    "Accept",
    "Authorization",
    "Content-Type",
    "Origin",
  ],
  maxAge: 86_400,
};

function stripTrailingSlash(path: string): string {
  return path.length > 1 && path.endsWith("/") ? path.replace(/\/+$/, "") : path;
}

function apiGlobalPrefix(env: RewriteEnv): string | null {
  const raw = env.API_GLOBAL_PREFIX;
  if (!raw || raw === "/") return null;
  const prefixed = raw.startsWith("/") ? raw : `/${raw}`;
  return stripTrailingSlash(prefixed);
}

function groupRoutes(table: readonly RouteRecord[]): readonly (readonly RouteRecord[])[] {
  const groups = new Map<string, RouteRecord[]>();
  for (const record of table) {
    const key = `${record.method} ${record.path}`;
    const group = groups.get(key);
    if (group) group.push(record);
    else groups.set(key, [record]);
  }
  return Array.from(groups.values());
}

function createInnerApp({
  table,
  scopeFor,
  originalUrls,
}: {
  table: readonly RouteRecord[];
  scopeFor: (moduleKey: string) => ModuleScope;
  originalUrls: WeakMap<Request, string>;
}): Hono<{ Bindings: ApiEnv }> {
  const app = new Hono<{ Bindings: ApiEnv }>({ strict: false });

  for (const group of groupRoutes(table)) {
    const first = group[0];
    const handle = async (context: ApiContext, next: Next): Promise<Response | undefined> => {
      const selected = extractApiVersion(context.req.header(CAL_API_VERSION_HEADER));
      const record = group.find((entry) => versionMatches(entry.version, selected));
      if (!record) {
        await next();
        return undefined;
      }

      const scope = scopeFor(record.moduleKey);
      const controller = scope.controllers.get(record.controllerClass);
      if (!controller) {
        throw new Error(
          `Module ${record.moduleKey} does not compose controller ${record.controllerClass.name}`
        );
      }
      const search = new URL(context.req.url).search;
      return executeRoute({
        record,
        raw: context.req.raw,
        params: context.req.param(),
        originalUrl: originalUrls.get(context.req.raw) ?? `${context.req.path}${search}`,
        controller,
      });
    };
    if (first.method === "ALL") app.all(first.path, handle);
    else app.on(first.method, first.path, handle);
  }

  app.notFound((context) =>
    notFoundResponse({
      method: context.req.method,
      path: context.req.path,
      search: new URL(context.req.url).search,
    })
  );
  app.onError((_error, context) => context.json({ statusCode: 500, message: "Internal server error" }, 500));
  return app;
}

export interface ApiEnv {
  DOCS_URL?: string;
  REWRITE_API_V2_PREFIX?: string;
  API_GLOBAL_PREFIX?: string;
}

export interface WorkerEnv extends ApiEnv {
  DB: D1Database;
}

export interface RewriteEnv {
  REWRITE_API_V2_PREFIX?: string;
  API_GLOBAL_PREFIX?: string;
}

export function rewritePath(pathname: string, env: RewriteEnv): string | null {
  const normalized = stripTrailingSlash(pathname);
  if (normalized === "/v2/health" || normalized === "/api/v2/health") return "/health";

  let target = pathname;
  if ((env.REWRITE_API_V2_PREFIX ?? "1") === "1" && target.startsWith("/api/v2")) {
    target = target.replace("/api/v2", "/v2");
  }
  if (target.startsWith("/v2/ee")) target = target.replace("/v2/ee", "/v2");
  if (target.includes("reccuring")) target = target.replace("reccuring", "recurring");

  return target === pathname ? null : target;
}

export function resolveInnerPath(pathname: string, env: RewriteEnv): { readonly path: string } | null {
  const prefix = apiGlobalPrefix(env);
  let unprefixed = pathname;
  if (prefix) {
    if (pathname !== prefix && !pathname.startsWith(`${prefix}/`)) return null;
    unprefixed = pathname.slice(prefix.length) || "/";
  }
  const rewritten = rewritePath(unprefixed, env);
  return { path: rewritten ?? unprefixed };
}

export function notFoundResponse({
  method,
  path,
  search,
}: {
  method: string;
  path: string;
  search: string;
}): Response {
  const message = `Cannot ${method} ${path}${search}`;
  return new Response(
    JSON.stringify({
      status: ERROR_STATUS,
      timestamp: new Date().toISOString(),
      path: `${path}${search}`,
      error: {
        code: "NotFoundException",
        message,
        details: { message, error: "Not Found", statusCode: 404 },
      },
    }),
    { status: 404, headers: { "content-type": "application/json" } }
  );
}

export function createApiApp({
  table,
  scopeFor,
}: {
  table: readonly RouteRecord[];
  scopeFor: (moduleKey: string) => ModuleScope;
}): Hono<{ Bindings: ApiEnv }> {
  const originalUrls = new WeakMap<Request, string>();
  const inner = createInnerApp({ table, scopeFor, originalUrls });
  const outer = new Hono<{ Bindings: ApiEnv }>();

  outer.use("*", secureHeaders());
  outer.use("*", cors(CORS_OPTIONS));
  outer.use("*", async (context, next) => {
    const { pathname } = new URL(context.req.url);
    if (context.env.DOCS_URL && (pathname.startsWith("/v2/docs") || pathname.startsWith("/docs"))) {
      return context.redirect(context.env.DOCS_URL, 302);
    }
    await next();
  });
  outer.all("*", async (context) => {
    const url = new URL(context.req.url);
    const resolved = resolveInnerPath(url.pathname, context.env);
    if (!resolved) {
      return notFoundResponse({ method: context.req.method, path: url.pathname, search: url.search });
    }
    if (resolved.path === url.pathname) {
      return inner.fetch(context.req.raw, context.env, context.executionCtx);
    }

    const rewrittenUrl = new URL(context.req.url);
    rewrittenUrl.pathname = resolved.path;
    const rewritten = new Request(rewrittenUrl.toString(), context.req.raw);
    originalUrls.set(rewritten, `${url.pathname}${url.search}`);
    return inner.fetch(rewritten, context.env, context.executionCtx);
  });
  outer.notFound((context) =>
    notFoundResponse({
      method: context.req.method,
      path: context.req.path,
      search: new URL(context.req.url).search,
    })
  );
  return outer;
}
