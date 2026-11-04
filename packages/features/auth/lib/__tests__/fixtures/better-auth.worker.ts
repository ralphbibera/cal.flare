import type { D1Environment } from "@calcom/prisma/d1";
import { betterAuth } from "better-auth";
import { createAuthEndpoint } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { getMigrations } from "better-auth/db/migration";
import { createBetterAuth } from "../../better-auth";

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
