import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { D1Environment } from "@calcom/prisma/d1";
import { betterAuth } from "better-auth";
import { sessionCookieSettings } from "./session-cookie";

type AuthRequestConfig = D1Environment & {
  baseURL: string;
  NEXTAUTH_SECRET: string;
  NEXTAUTH_COOKIE_DOMAIN?: string;
  webappURL?: string;
};

// Compose inside the owned request boundary. Credential sign-in is added by the Cal plugin.
export function createBetterAuth({
  DB,
  baseURL,
  NEXTAUTH_SECRET,
  NEXTAUTH_COOKIE_DOMAIN,
  webappURL,
}: AuthRequestConfig) {
  if (!NEXTAUTH_SECRET?.trim()) {
    throw new ErrorWithCode(ErrorCode.InternalServerError, "NEXTAUTH_SECRET is required for auth");
  }
  return betterAuth({
    database: DB,
    baseURL,
    basePath: "/api/auth",
    secret: NEXTAUTH_SECRET,
    telemetry: { enabled: false },
    user: {
      modelName: "AuthUser",
      additionalFields: {
        // SDK references infer opaque TEXT IDs. The reviewed D1 migration owns the numeric domain FK.
        calUserId: { type: "number", required: true, unique: true, input: false },
      },
    },
    session: {
      modelName: "AuthSession",
      expiresIn: 30 * 24 * 60 * 60,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        calClaims: { type: "json", required: true, input: false },
        profileContext: { type: "json", required: false, input: false },
      },
    },
    account: { modelName: "AuthAccount", accountLinking: { enabled: false } },
    verification: { modelName: "AuthVerification" },
    emailAndPassword: { enabled: false, disableSignUp: true },
    disabledPaths: [
      "/sign-up/email",
      "/sign-in/email",
      "/sign-in/social",
      "/link-social",
      "/link-account",
      "/unlink-account",
      "/update-user",
      "/delete-user",
      "/change-email",
      "/change-password",
      "/set-password",
      "/request-password-reset",
      "/reset-password",
      // Its session carries no Cal claims; /cal/magic-link/verify consumes the same native token.
      "/magic-link/verify",
    ],
    advanced: {
      ...sessionCookieSettings({ baseURL, webappURL, NEXTAUTH_COOKIE_DOMAIN }),
      // The SDK turns origin checks off under NODE_ENV=test unless they are pinned.
      disableOriginCheck: false,
      disableCSRFCheck: false,
    },
  });
}
