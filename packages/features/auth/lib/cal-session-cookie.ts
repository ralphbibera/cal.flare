import type { Session } from "next-auth";
import type { GetTokenParams } from "next-auth/jwt";
import { createCalRequestAuth } from "./request-auth";
import { getAuthRequestConfiguration } from "./request-context";

type SessionRequest = GetTokenParams["req"];

const sessionCookie = "next-auth.session-token";
const secureSessionCookie = `__Secure-${sessionCookie}`;

function readCookie(req: SessionRequest, name: string): string | undefined {
  const cookies = req?.cookies;
  if (cookies) {
    if (typeof cookies.getAll === "function") {
      const found = cookies.getAll().find((cookie) => cookie.name === name);
      if (found) return found.value;
    } else if (cookies instanceof Map) {
      const value = cookies.get(name);
      if (value !== undefined) return value;
    } else {
      const value = (cookies as Record<string, string | undefined>)[name];
      if (value !== undefined) return value;
    }
  }

  let header: string | null | undefined;
  if (req?.headers instanceof Headers) header = req.headers.get("cookie");
  else header = req?.headers?.cookie;
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const index = part.indexOf("=");
    if (index === -1 || part.slice(0, index).trim() !== name) continue;
    const value = part.slice(index + 1).trim();
    try {
      return decodeURIComponent(value);
    } catch {
      return value;
    }
  }
  return undefined;
}

type CalReader = { auth: ReturnType<typeof createCalRequestAuth>; headers: Headers };

function createCalReader(rawToken: string): CalReader | null {
  if (!isCalSignedSessionToken(rawToken)) return null;
  // Without a request-bound configuration (D1 and signing secret) the Cal reader cannot run.
  const config = getAuthRequestConfiguration();
  if (!config) return null;
  let name = sessionCookie;
  if (config.webappURL.startsWith("https://")) name = secureSessionCookie;
  const headers = new Headers({ cookie: `${name}=${encodeURIComponent(rawToken)}` });
  return { auth: createCalRequestAuth(config), headers };
}

/**
 * A next-auth session is a five-segment JWE, while better-call's signed cookie value is
 * `token.base64(HMAC)`. Only the latter is routed to the Cal reader.
 */
export function isCalSignedSessionToken(rawToken: unknown): rawToken is string {
  return typeof rawToken === "string" && rawToken.length > 0 && rawToken.split(".").length === 2;
}

export async function readSessionToken(req: SessionRequest): Promise<string | null> {
  return readCookie(req, secureSessionCookie) ?? readCookie(req, sessionCookie) ?? null;
}

export async function getCalServerSession(rawToken: string | null): Promise<Session | null> {
  if (!rawToken) return null;
  try {
    const reader = createCalReader(rawToken);
    if (!reader) return null;
    const session = await reader.auth.api.getServerSession({ headers: reader.headers });
    if (!session) return null;
    // The JWE path represents an absent organization as undefined; normalize the nullable claim the same way.
    return { ...session, user: { ...session.user, org: session.user.org ?? undefined } };
  } catch {
    return null;
  }
}

export async function getCalSessionLocale(rawToken: string | null): Promise<string | null> {
  if (!rawToken) return null;
  try {
    const reader = createCalReader(rawToken);
    if (!reader) return null;
    const session = await reader.auth.api.getSessionClaims({ headers: reader.headers });
    return session?.claims.locale ?? null;
  } catch {
    return null;
  }
}
