import type { BetterAuthOptions } from "better-auth";
import { getCookies, SECURE_COOKIE_PREFIX } from "better-auth/cookies";

type SessionCookieSettings = {
  useSecureCookies: boolean;
  cookies: {
    session_token: {
      attributes: {
        domain: string | undefined;
        sameSite: "none" | "lax";
        secure: boolean;
        httpOnly: boolean;
        path: string;
        maxAge: number;
      };
    };
  };
};

export const SESSION_COOKIE_MAX_AGE_SECONDS: number = 30 * 24 * 60 * 60;

export type SessionCookieConfiguration = {
  baseURL: string;
  webappURL?: string;
  NEXTAUTH_COOKIE_DOMAIN?: string;
};

export type SessionCookieDeletion = {
  name: string;
  path: string | undefined;
  domain: string | undefined;
  secure: boolean;
};

// Shared with the logout middleware so both derive the session cookie name and scope from one policy.
export function sessionCookieSettings({
  baseURL,
  webappURL,
  NEXTAUTH_COOKIE_DOMAIN,
}: SessionCookieConfiguration): SessionCookieSettings {
  const secure = (webappURL ?? baseURL).startsWith("https://");
  let sameSite: "none" | "lax" = "lax";
  if (secure) sameSite = "none";
  return {
    useSecureCookies: secure,
    cookies: {
      session_token: {
        attributes: {
          domain: NEXTAUTH_COOKIE_DOMAIN || undefined,
          sameSite,
          secure,
          httpOnly: true,
          path: "/",
          maxAge: SESSION_COOKIE_MAX_AGE_SECONDS,
        },
      },
    },
  } satisfies NonNullable<BetterAuthOptions["advanced"]>;
}

export function sessionCookieDeletions(config: SessionCookieConfiguration): SessionCookieDeletion[] {
  const settings = sessionCookieSettings(config);
  return [settings.useSecureCookies, !settings.useSecureCookies].map((useSecureCookies) => {
    const { name, attributes } = getCookies({
      baseURL: config.baseURL,
      advanced: { ...settings, useSecureCookies },
    }).sessionToken;
    return {
      name,
      path: attributes.path,
      domain: attributes.domain,
      secure: name.startsWith(SECURE_COOKIE_PREFIX),
    };
  });
}
