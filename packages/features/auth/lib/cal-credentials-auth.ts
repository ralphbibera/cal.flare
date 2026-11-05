import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import type { setSessionCookie } from "better-auth/cookies";
import { deleteSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import { authorizeCredentials } from "./authorizeCredentials";
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

type AuthConfig = Parameters<typeof createBetterAuth>[0] & { webappURL: string };
type EndpointContext = Parameters<typeof setSessionCookie>[0];
const form = z.object({
  csrfToken: z.string().optional(),
  callbackUrl: z.string().optional(),
  json: z.string().optional(),
});
const credentialsForm = form.extend({
  email: z.string().default(""),
  password: z.string().default(""),
  totpCode: z.string().default(""),
  backupCode: z.string().default(""),
});

async function csrfHash(token: string, secret: string) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token + secret));
  return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

// This credential unit remains unmounted until the retained email and OAuth branches are ported.
export function createCalCredentialsAuth(config: AuthConfig) {
  const core = createBetterAuth(config);
  const sessions = createCalSessionStore(config);
  const origin = new URL(config.baseURL).origin;
  const apiURL = `${origin}/api/auth`;
  const secure = new URL(origin).protocol === "https:";
  const prefix = secure ? "__Secure-" : "";
  const sameSite: "none" | "lax" = secure ? "none" : "lax";
  const attributes = { domain: config.NEXTAUTH_COOKIE_DOMAIN || undefined, sameSite, secure, path: "/" };
  const csrfCookie = `${prefix}next-auth.csrf-token`;
  const callbackCookie = `${prefix}next-auth.callback-url`;

  async function csrf(ctx: EndpointContext, submitted?: string) {
    const cookie = ctx.getCookie(csrfCookie);
    const [token, digest] = cookie?.split("|") ?? [];
    if (token && digest === (await csrfHash(token, config.NEXTAUTH_SECRET))) {
      return { token, verified: token === submitted };
    }
    const generated = Array.from(crypto.getRandomValues(new Uint8Array(32)), (byte) =>
      byte.toString(16).padStart(2, "0")
    ).join("");
    ctx.setCookie(csrfCookie, `${generated}|${await csrfHash(generated, config.NEXTAUTH_SECRET)}`, {
      ...attributes,
      httpOnly: true,
    });
    return { token: generated, verified: false };
  }

  function callback(ctx: EndpointContext, requested?: string) {
    const target = requested || ctx.getCookie(callbackCookie) || origin;
    let url = origin;
    if (target.startsWith("/")) url = `${origin}${target}`;
    else {
      try {
        if (new URL(target).hostname === new URL(config.webappURL).hostname) url = target;
      } catch {
        url = origin;
      }
    }
    if (url !== ctx.getCookie(callbackCookie)) ctx.setCookie(callbackCookie, url, attributes);
    return url;
  }

  function redirect(ctx: EndpointContext, url: string, json?: string, status: 200 | 401 = 200) {
    if (json === "true") {
      ctx.setStatus(status);
      return ctx.json({ url });
    }
    throw ctx.redirect(url);
  }

  const auth = betterAuth({
    ...core.options,
    // Cal's authorizer owns throttling and its position in the credential guard order.
    rateLimit: { enabled: false },
    plugins: [
      {
        id: "cal-credentials",
        endpoints: {
          calSigninPage: createAuthEndpoint(
            "/signin",
            {
              method: "GET",
              query: z.object({ callbackUrl: z.string().optional(), error: z.string().optional() }),
            },
            async (ctx) => {
              await csrf(ctx);
              const target = callback(ctx, ctx.query.callbackUrl);
              const error = ctx.query.error ? `&error=${encodeURIComponent(ctx.query.error)}` : "";
              throw ctx.redirect(`/auth/login?callbackUrl=${encodeURIComponent(target)}${error}`);
            }
          ),
          calSignoutPage: createAuthEndpoint("/signout", { method: "GET" }, async (ctx) => {
            await csrf(ctx);
            callback(ctx);
            throw ctx.redirect("/auth/logout");
          }),
          calError: createAuthEndpoint(
            "/cal/error",
            { method: "GET", query: z.object({ error: z.string().optional() }) },
            async (ctx) => {
              await csrf(ctx);
              callback(ctx);
              const error = ctx.query.error ?? "undefined";
              if (
                [
                  "Signin",
                  "OAuthSignin",
                  "OAuthCallback",
                  "OAuthCreateAccount",
                  "EmailCreateAccount",
                  "Callback",
                  "OAuthAccountNotLinked",
                  "EmailSignin",
                  "CredentialsSignin",
                  "SessionRequired",
                ].includes(error)
              )
                throw ctx.redirect(`${apiURL}/signin?error=${encodeURIComponent(error)}`);
              throw ctx.redirect(`/auth/error?error=${encodeURIComponent(error)}`);
            }
          ),
          calProviders: createAuthEndpoint("/providers", { method: "GET" }, async (ctx) => {
            await csrf(ctx);
            callback(ctx);
            return ctx.json({
              credentials: {
                id: "credentials",
                name: "Cal.flare",
                type: "credentials",
                signinUrl: `${apiURL}/signin/credentials`,
                callbackUrl: `${apiURL}/callback/credentials`,
              },
            });
          }),
          calCsrf: createAuthEndpoint("/csrf", { method: "GET" }, async (ctx) => {
            callback(ctx);
            ctx.setHeader("cache-control", "private, no-cache, no-store");
            ctx.setHeader("pragma", "no-cache");
            ctx.setHeader("expires", "0");
            return ctx.json({ csrfToken: (await csrf(ctx)).token });
          }),
          calCredentials: createAuthEndpoint(
            "/callback/credentials",
            {
              method: "POST",
              body: credentialsForm,
              metadata: { allowedMediaTypes: ["application/json", "application/x-www-form-urlencoded"] },
            },
            async (ctx) => {
              const target = callback(ctx, ctx.body.callbackUrl);
              if (!(await csrf(ctx, ctx.body.csrfToken)).verified)
                return redirect(ctx, `${apiURL}/signin?csrf=true`, ctx.body.json);
              let user;
              try {
                user = await authorizeCredentials(ctx.body);
              } catch (error) {
                const message = error instanceof Error ? error.message : "internal-server-error";
                return redirect(
                  ctx,
                  `${apiURL}/error?error=${encodeURIComponent(message)}`,
                  ctx.body.json,
                  401
                );
              }
              await sessions.issue(ctx, {
                ...credentialSession(user),
                ...(await getCalSessionSettings(user.id)),
              });
              return redirect(ctx, target, ctx.body.json);
            }
          ),
          calSession: createAuthEndpoint(
            "/session",
            {
              method: ["GET", "POST"],
              body: z
                .object({ csrfToken: z.string().optional(), data: calSessionUpdateSchema.optional() })
                .optional(),
            },
            async (ctx) => {
              ctx.setHeader("cache-control", "private, no-cache, no-store");
              ctx.setHeader("pragma", "no-cache");
              ctx.setHeader("expires", "0");
              const { verified } = await csrf(ctx, ctx.body?.csrfToken);
              callback(ctx);
              if (ctx.method === "POST" && !verified) {
                ctx.setStatus(400);
                return ctx.json({});
              }
              const stored = await sessions.read(ctx);
              if (!stored) {
                if (ctx.getCookie(ctx.context.authCookies.sessionToken.name)) deleteSessionCookie(ctx);
                return ctx.json({});
              }
              let snapshot;
              try {
                snapshot =
                  ctx.method === "POST"
                    ? await updateCalSession(stored, ctx.body?.data ?? {})
                    : await refreshCalSession(stored);
              } catch (error) {
                if (error instanceof ErrorWithCode && error.code === ErrorCode.Forbidden) {
                  ctx.setStatus(403);
                  return ctx.json({});
                }
                throw error;
              }
              const renewed = await sessions.renew(ctx, {
                ...snapshot,
                sessionTimeout: (await getCalSessionSettings(stored.claims.id)).sessionTimeout,
              });
              return ctx.json(renewed ? browserSession(renewed.claims, renewed.profile) : {});
            }
          ),
          calSignout: createAuthEndpoint(
            "/signout",
            {
              method: "POST",
              body: form,
              metadata: { allowedMediaTypes: ["application/json", "application/x-www-form-urlencoded"] },
            },
            async (ctx) => {
              const target = callback(ctx, ctx.body.callbackUrl);
              if (!(await csrf(ctx, ctx.body.csrfToken)).verified)
                return redirect(ctx, `${apiURL}/signout?csrf=true`, ctx.body.json);
              await sessions.revoke(ctx);
              return redirect(ctx, target, ctx.body.json);
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
    api: {
      getServerSession: auth.api.calServerSession,
      getSessionClaims: auth.api.calSessionClaims,
    },
    handler(request: Request) {
      const url = new URL(request.url);
      const path = url.pathname;
      if (
        !["providers", "csrf", "callback/credentials", "session", "signout", "signin", "error"].some(
          (route) => path === `/api/auth/${route}`
        )
      )
        return Promise.resolve(new Response(null, { status: 404 }));
      // The SDK reserves /error; keep Cal's public error route and page contract.
      if (path === "/api/auth/error" && request.method === "GET") {
        url.pathname = "/api/auth/cal/error";
        return auth.handler(new Request(url, request));
      }
      return auth.handler(request);
    },
  };
}
