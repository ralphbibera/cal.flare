import { ErrorCode as CalErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { HttpError } from "@calcom/lib/http-error";
import { betterAuth } from "better-auth";
import { APIError, createAuthEndpoint, formCsrfMiddleware } from "better-auth/api";
import type { setSessionCookie } from "better-auth/cookies";
import { deleteSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { authorizeCredentials, authorizeCredentialsForRequest } from "./authorizeCredentials";
import { createBetterAuth } from "./better-auth";
import { projectCalServerSession } from "./cal-server-session";
import { browserSession, credentialSession } from "./cal-session";
import {
  calSessionUpdateSchema,
  getCalSessionSettings,
  refreshCalSession,
  updateCalSession,
} from "./cal-session-policy";
import { createCalSessionStore } from "./cal-session-store";
import { ErrorCode } from "./ErrorCode";
import type { CredentialPolicy } from "./request-context";

type AuthConfig = Parameters<typeof createBetterAuth>[0] & {
  webappURL: string;
  credentialPolicy?: CredentialPolicy;
};
type EndpointContext = Parameters<typeof setSessionCookie>[0];

const credentialsBody = z.object({
  email: z.string().default(""),
  password: z.string().default(""),
  totpCode: z.string().default(""),
  backupCode: z.string().default(""),
  callbackUrl: z.string().optional(),
});
const calErrorCodes: ReadonlySet<string> = new Set(Object.values(ErrorCode));

function credentialError(error: unknown) {
  if (error instanceof HttpError && error.statusCode === 429)
    return APIError.from("TOO_MANY_REQUESTS", { code: "RATE_LIMIT_EXCEEDED", message: error.message });
  const message = error instanceof Error ? error.message : "";
  // Anything outside Cal's error vocabulary may carry internals, so it is reported as an internal error.
  const code = calErrorCodes.has(message) ? message : ErrorCode.InternalServerError;
  let status: "UNAUTHORIZED" | "FORBIDDEN" | "INTERNAL_SERVER_ERROR" = "UNAUTHORIZED";
  if (code === ErrorCode.InternalServerError) status = "INTERNAL_SERVER_ERROR";
  if (code === ErrorCode.UserAccountLocked) status = "FORBIDDEN";
  return APIError.from(status, { code: code.toUpperCase().replaceAll("-", "_"), message: code });
}

function noStore(ctx: EndpointContext) {
  ctx.setHeader("cache-control", "private, no-cache, no-store");
  ctx.setHeader("pragma", "no-cache");
  ctx.setHeader("expires", "0");
}

export function createCalCredentialsAuth(config: AuthConfig) {
  const core = createBetterAuth(config);
  const sessions = createCalSessionStore(config);
  const origin = new URL(config.baseURL).origin;

  function callback(requested?: string) {
    if (!requested) return origin;
    if (requested.startsWith("/")) return `${origin}${requested}`;
    try {
      const parsed = new URL(requested);
      if (
        (parsed.protocol === "http:" || parsed.protocol === "https:") &&
        parsed.hostname === new URL(config.webappURL).hostname
      )
        return requested;
    } catch {
      return origin;
    }
    return origin;
  }

  const auth = betterAuth({
    ...core.options,
    // Cal's authorizer owns throttling and its position in the credential guard order.
    rateLimit: { enabled: false },
    plugins: [
      {
        id: "cal-credentials",
        endpoints: {
          calCredentials: createAuthEndpoint(
            "/sign-in/cal-credentials",
            { method: "POST", body: credentialsBody, use: [formCsrfMiddleware] },
            async (ctx) => {
              noStore(ctx);
              const { callbackUrl, ...credentials } = ctx.body;
              let user;
              try {
                user = config.credentialPolicy
                  ? await authorizeCredentialsForRequest(credentials, config.credentialPolicy)
                  : await authorizeCredentials(credentials);
              } catch (error) {
                throw credentialError(error);
              }
              const issued = credentialSession(user);
              await sessions.issue(ctx, { ...issued, ...(await getCalSessionSettings(user.id)) });
              return ctx.json({
                redirect: Boolean(callbackUrl),
                url: callback(callbackUrl),
                user: browserSession(issued.claims, issued.profile).user,
              });
            }
          ),
          getSession: createAuthEndpoint(
            "/get-session",
            { method: "GET", requireHeaders: true },
            async (ctx) => {
              noStore(ctx);
              const stored = await sessions.read(ctx);
              if (!stored) {
                if (ctx.getCookie(ctx.context.authCookies.sessionToken.name)) deleteSessionCookie(ctx);
                return ctx.json(null);
              }
              let snapshot: Awaited<ReturnType<typeof refreshCalSession>>;
              try {
                snapshot = await refreshCalSession(stored);
              } catch (error) {
                if (error instanceof ErrorWithCode && error.code === CalErrorCode.Forbidden)
                  throw APIError.from("FORBIDDEN", { code: "FORBIDDEN", message: "forbidden" });
                throw error;
              }
              const renewed = await sessions.renew(ctx, {
                ...snapshot,
                sessionTimeout: (await getCalSessionSettings(stored.claims.id)).sessionTimeout,
              });
              return ctx.json(renewed ? browserSession(renewed.claims, renewed.profile) : null);
            }
          ),
          calUpdateSession: createAuthEndpoint(
            "/cal/update-session",
            {
              method: "POST",
              body: z.object({ data: calSessionUpdateSchema.optional() }).optional(),
              requireHeaders: true,
            },
            async (ctx) => {
              noStore(ctx);
              const stored = await sessions.read(ctx);
              if (!stored)
                throw APIError.from("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "unauthorized" });
              let snapshot: Awaited<ReturnType<typeof refreshCalSession>>;
              try {
                snapshot = await updateCalSession(stored, ctx.body?.data ?? {});
              } catch (error) {
                if (error instanceof ErrorWithCode && error.code === CalErrorCode.Forbidden)
                  throw APIError.from("FORBIDDEN", { code: "FORBIDDEN", message: "forbidden" });
                throw error;
              }
              const renewed = await sessions.renew(ctx, {
                ...snapshot,
                sessionTimeout: (await getCalSessionSettings(stored.claims.id)).sessionTimeout,
              });
              if (!renewed)
                throw APIError.from("UNAUTHORIZED", { code: "UNAUTHORIZED", message: "unauthorized" });
              return ctx.json(browserSession(renewed.claims, renewed.profile));
            }
          ),
          calServerSession: createAuthEndpoint.serverOnly(
            { method: "GET", requireHeaders: true },
            async (ctx) => {
              const stored = await sessions.read(ctx);
              return stored
                ? projectCalServerSession({ ...stored, expiresAt: stored.session.expiresAt })
                : null;
            }
          ),
          calSessionClaims: createAuthEndpoint.serverOnly(
            { method: "GET", requireHeaders: true },
            async (ctx) => {
              const stored = await sessions.read(ctx);
              return stored
                ? { claims: stored.claims, profile: stored.profile, expiresAt: stored.session.expiresAt }
                : null;
            }
          ),
        },
      },
    ],
  });

  return {
    options: auth.options,
    api: {
      getServerSession: auth.api.calServerSession,
      getSessionClaims: auth.api.calSessionClaims,
    },
    handler: (request: Request) => auth.handler(request),
  };
}

export type CalCredentialsServerPlugin = ReturnType<typeof createCalCredentialsAuth>["options"]["plugins"][number];
