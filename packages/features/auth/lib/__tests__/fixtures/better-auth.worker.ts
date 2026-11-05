import type { D1Environment } from "@calcom/prisma/d1";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { getMigrations } from "better-auth/db/migration";
import { z } from "zod";
import { createBetterAuth } from "../../better-auth";
import { browserSession } from "../../cal-session";
import { createCalSessionStore } from "../../cal-session-store";

// Library-only fixture: never mounted by the application, never evidence of Cal login policy.
export default {
  async fetch(request: Request, env: D1Environment & { SCHEMA: D1Environment["DB"] }) {
    const url = new URL(request.url);
    const config = {
      DB: env.DB,
      baseURL: url.origin,
      NEXTAUTH_SECRET: "synthetic-library-test-only-secret-0123456789",
      NEXTAUTH_COOKIE_DOMAIN: url.hostname === "calflare.test" ? ".calflare.test" : undefined,
    };
    const core = createBetterAuth(config);
    const sessions = createCalSessionStore(env);
    if (url.pathname === "/schema") {
      const migrations = await getMigrations(createBetterAuth({ ...config, DB: env.SCHEMA }).options);
      return new Response(await migrations.compileMigrations());
    }
    if (url.pathname === "/missing-secret") {
      try {
        createBetterAuth({ ...config, NEXTAUTH_SECRET: "" });
        return new Response("accepted", { status: 500 });
      } catch {
        return new Response("rejected");
      }
    }
    const auth = betterAuth({
      ...core.options,
      plugins: [
        {
          id: "library-session-fixture",
          endpoints: {
            calIssue: createAuthEndpoint(
              "/fixture-cal/issue",
              {
                method: "POST",
                body: z.object({
                  sessionTimeout: z.number().optional(),
                  id: z.number().int().positive().default(123),
                  email: z.string().default("library@calflare.test"),
                }),
              },
              async (ctx) => {
                await sessions.issue(ctx, {
                  claims: {
                    id: ctx.body.id,
                    email: ctx.body.email,
                    name: "Cal user",
                    role: "INACTIVE_ADMIN",
                    inactiveAdminReason: "both",
                    locale: "de",
                  },
                  profile: { profileId: null, upId: "usr-123" },
                  emailVerified: false,
                  sessionTimeout: ctx.body.sessionTimeout,
                });
                return ctx.json({ url: "/" });
              }
            ),
            calRead: createAuthEndpoint("/fixture-cal/read", { method: "GET" }, async (ctx) => {
              const stored = await sessions.read(ctx);
              return ctx.json(
                stored
                  ? {
                      browser: browserSession(stored.claims, stored.profile),
                      expiresAt: stored.session.expiresAt,
                    }
                  : null
              );
            }),
            calRenew: createAuthEndpoint("/fixture-cal/renew", { method: "POST" }, async (ctx) => {
              const stored = await sessions.read(ctx);
              if (!stored) return ctx.json(null);
              const renewed = await sessions.renew(ctx, {
                claims: { ...stored.claims, locale: "ar" },
                profile: stored.profile,
                sessionTimeout: 5,
              });
              return ctx.json(renewed ? browserSession(renewed.claims, renewed.profile) : null);
            }),
            calRevoke: createAuthEndpoint("/fixture-cal/revoke", { method: "POST" }, async (ctx) => {
              await sessions.revoke(ctx);
              return ctx.json({ url: "/" });
            }),
            fixture: createAuthEndpoint("/fixture-session", { method: "POST" }, async (ctx) => {
              const user = await ctx.context.internalAdapter.createUser(
                {
                  name: "Synthetic domain user",
                  email: "library@calflare.test",
                  calUserId: 123,
                },
                { method: "library-fixture" }
              );
              await ctx.context.internalAdapter.createAccount({
                userId: user.id,
                accountId: "synthetic-subject",
                providerId: "library-fixture",
              });
              await ctx.context.internalAdapter.createVerificationValue({
                identifier: "synthetic-verification",
                value: "synthetic-value",
                expiresAt: new Date(Date.now() + 60_000),
              });
              const session = await ctx.context.internalAdapter.createSession(user.id, false, {
                calClaims: { id: 123, role: "USER", hasValidLicense: false },
                profileContext: { profileId: 7, upId: "123" },
              });
              await setSessionCookie(ctx, { user, session });
              return ctx.json({ user, session });
            }),
          },
        },
      ],
    });
    return auth.handler(request);
  },
};
