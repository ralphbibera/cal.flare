import process from "node:process";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import {
  GOOGLE_CALENDAR_SCOPES,
  GOOGLE_OAUTH_SCOPES,
  MICROSOFT_CALENDAR_SCOPES,
} from "@calcom/lib/constants";
import { ErrorCode as CalErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import logger from "@calcom/lib/logger";
import prisma from "@calcom/prisma";
import type { BetterAuthOptions } from "better-auth";
import { APIError, createAuthEndpoint, createAuthMiddleware } from "better-auth/api";
import { parseState } from "better-auth/oauth2";
import { z } from "zod";
import type { createCalSessionStore } from "./cal-session-store";
import { issueUserSession } from "./cal-user-session";
import type { OAuthSignInPort } from "./OAuthSignIn.types";
import { oauthProfileSchema } from "./OAuthSignIn.types";
import { OUTLOOK_CLIENT_ID, OUTLOOK_CLIENT_SECRET, OUTLOOK_LOGIN_ENABLED } from "./outlook";

const log = logger.getSubLogger({ prefix: ["cal-oauth"] });

type ClientCredentials = { clientId: string; clientSecret: string };
export type OAuthProvidersConfig = { google?: ClientCredentials; microsoft?: ClientCredentials };

// Source: next-auth's built-in error codes for a failed provider round trip and a refused sign-in.
const CALLBACK_ERROR = "OAuthCallback";
const ACCESS_DENIED = "AccessDenied";
const SESSION_ERROR = "Callback";

// The wire id is Better Auth's; `provider` is the value stored in `Account.provider` by every release so far.
// The callback path stays next-auth's because the deployed OAuth app registrations point there.
const OAUTH_LOGINS = [
  { provider: "google", socialId: "google", callbackPath: "/callback/google" },
  { provider: "azure-ad", socialId: "microsoft", callbackPath: "/callback/azure-ad" },
] as const;
type OAuthLogin = (typeof OAUTH_LOGINS)[number];

const googleCredentialsSchema = z.object({
  web: z.object({ client_id: z.string().optional(), client_secret: z.string().optional() }).optional(),
});

// Read per call: an unparsable GOOGLE_API_CREDENTIALS must only disable Google, not every auth request.
export function readOAuthProvidersConfig(): OAuthProvidersConfig {
  const config: OAuthProvidersConfig = {};
  let parsed: z.infer<typeof googleCredentialsSchema> = {};
  try {
    parsed = googleCredentialsSchema.parse(JSON.parse(process.env.GOOGLE_API_CREDENTIALS || "{}"));
  } catch (error) {
    log.warn("GOOGLE_API_CREDENTIALS is not valid, Google login is disabled", error);
  }
  const { client_id: clientId, client_secret: clientSecret } = parsed.web ?? {};
  if (clientId && clientSecret && process.env.GOOGLE_LOGIN_ENABLED === "true") {
    config.google = { clientId, clientSecret };
  }
  if (OUTLOOK_LOGIN_ENABLED && OUTLOOK_CLIENT_ID && OUTLOOK_CLIENT_SECRET) {
    config.microsoft = { clientId: OUTLOOK_CLIENT_ID, clientSecret: OUTLOOK_CLIENT_SECRET };
  }
  return config;
}

export function socialProviderOptions(
  config: OAuthProvidersConfig,
  baseURL: string
): NonNullable<BetterAuthOptions["socialProviders"]> {
  const origin = new URL(baseURL).origin;
  const redirectURI = (login: OAuthLogin) => `${origin}/api/auth${login.callbackPath}`;
  const [google, microsoft] = OAUTH_LOGINS;
  return {
    ...(config.google && {
      google: {
        ...config.google,
        redirectURI: redirectURI(google),
        disableDefaultScope: true,
        scope: [...GOOGLE_OAUTH_SCOPES, ...GOOGLE_CALENDAR_SCOPES],
        accessType: "offline",
        prompt: "consent",
        // next-auth sent no include_granted_scopes, so the grant is exactly the scopes above.
        includeGrantedScopes: false,
      },
    }),
    ...(config.microsoft && {
      microsoft: {
        ...config.microsoft,
        redirectURI: redirectURI(microsoft),
        disableDefaultScope: true,
        scope: ["openid", "profile", "email", ...MICROSOFT_CALENDAR_SCOPES],
        prompt: "consent",
        // The inline base64 photo bloats the profile; it is fetched separately after sign-in.
        disableProfilePhoto: true,
      },
    }),
  };
}

// The provider-wide stable id, not the e-mail, is what Account and users.identityProviderId were keyed on.
const oauthClaimsSchema = z.object({ sub: z.string().min(1) }).passthrough();

const callbackQuery = z.object({
  code: z.string().optional(),
  state: z.string().optional(),
  error: z.string().optional(),
});

type CalOAuthConfig = {
  webappURL: string;
  sessions: ReturnType<typeof createCalSessionStore>;
  callback: (requested?: string) => string;
  oauthSignIn: OAuthSignInPort;
};

export function createCalOAuth({ webappURL, sessions, callback, oauthSignIn }: CalOAuthConfig) {
  const webappOrigin = new URL(webappURL).origin;

  const callbackEndpoint = (login: OAuthLogin) =>
    createAuthEndpoint(
      login.callbackPath,
      { method: "GET", query: callbackQuery, requireHeaders: true },
      async (ctx) => {
        const fail = (code: string) => {
          const target = new URL("/auth/error", webappOrigin);
          target.searchParams.set("error", code);
          return ctx.redirect(target.toString());
        };
        const { code, state, error } = ctx.query;
        if (!state || error || !code) throw fail(CALLBACK_ERROR);

        const pending = await parseState(ctx).catch(() => null);
        if (!pending) throw fail(CALLBACK_ERROR);
        const provider = ctx.context.socialProviders.find((candidate) => candidate.id === login.socialId);
        if (!provider) throw fail(CALLBACK_ERROR);

        const tokens = await provider
          .validateAuthorizationCode({
            code,
            codeVerifier: pending.codeVerifier,
            redirectURI: `${ctx.context.baseURL}${login.callbackPath}`,
          })
          .catch(() => null);
        if (!tokens) throw fail(CALLBACK_ERROR);
        const info = await provider.getUserInfo(tokens).catch(() => null);
        const claims = oauthClaimsSchema.safeParse(info?.data);
        if (!info?.user || !claims.success) throw fail(CALLBACK_ERROR);
        const subject = claims.data.sub;

        const user = {
          id: subject,
          email: info.user.email,
          name: info.user.name,
          // Azure AD pictures never reached the user row; Microsoft Graph fills the avatar afterwards.
          image: login.provider === "azure-ad" ? null : info.user.image,
          emailVerified: null,
        };
        const account = {
          provider: login.provider,
          providerAccountId: subject,
          type: "oauth",
          access_token: tokens.accessToken,
          refresh_token: tokens.refreshToken,
          expires_at: tokens.accessTokenExpiresAt
            ? Math.floor(tokens.accessTokenExpiresAt.getTime() / 1000)
            : undefined,
          token_type: tokens.tokenType,
          scope: tokens.scopes?.join(" "),
          id_token: tokens.idToken,
        };
        const decision = await oauthSignIn.signIn({
          user,
          account,
          profile: oauthProfileSchema.parse(claims.data),
        });
        if (decision.kind === "deny") throw fail(ACCESS_DENIED);
        if (decision.kind === "redirect") throw ctx.redirect(new URL(decision.to, webappOrigin).toString());

        try {
          await oauthSignIn.completeSignIn({ userId: decision.userId, user, account });
          const record = await prisma.user.findUnique({
            where: { id: decision.userId },
            select: { email: true },
          });
          const calUser = record
            ? await new UserRepository(prisma).findByEmailAndIncludeProfilesAndPassword({
                email: record.email,
              })
            : null;
          if (!calUser) throw fail(SESSION_ERROR);
          await issueUserSession({ ctx, sessions, user: calUser });
        } catch (sessionError) {
          if (sessionError instanceof APIError) throw sessionError;
          if (sessionError instanceof ErrorWithCode && sessionError.code === CalErrorCode.Unauthorized)
            throw fail(ACCESS_DENIED);
          log.error("OAuth sign-in could not be completed", sessionError);
          throw fail(SESSION_ERROR);
        }
        ctx.setHeader("cache-control", "private, no-cache, no-store");
        throw ctx.redirect(callback(pending.callbackURL));
      }
    );

  return {
    id: "cal-oauth",
    endpoints: {
      calOAuthCallbackGoogle: callbackEndpoint(OAUTH_LOGINS[0]),
      calOAuthCallbackAzureAd: callbackEndpoint(OAUTH_LOGINS[1]),
    },
    hooks: {
      before: [
        {
          // An id token would sign in through the native handler, whose session carries no Cal claims.
          matcher: (context: { path?: string }) => context.path === "/sign-in/social",
          handler: createAuthMiddleware(async (ctx) => {
            if (ctx.body?.idToken) {
              throw APIError.from("BAD_REQUEST", {
                code: "ID_TOKEN_NOT_SUPPORTED",
                message: "id token sign-in is not supported",
              });
            }
          }),
        },
      ],
    },
  };
}
