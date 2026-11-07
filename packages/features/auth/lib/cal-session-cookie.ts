import type { IncomingHttpHeaders } from "node:http";
import type { GetServerSidePropsContext } from "next";
import type { NextRequest } from "next/server";
import type { Session } from "next-auth";
import { createCalRequestAuth } from "./request-auth";
import { getAuthRequestConfiguration } from "./request-context";

export type SessionRequest =
  | GetServerSidePropsContext["req"]
  | NextRequest
  | Request
  | {
      headers: Headers | IncomingHttpHeaders | Record<string, string>;
      cookies?:
        | Partial<Record<string, string>>
        | Map<string, string>
        | { getAll(): { name: string; value: string }[] };
    };

const sessionCookie = "next-auth.session-token";
const secureSessionCookie = `__Secure-${sessionCookie}`;

function readCookie(req: SessionRequest, name: string): string | undefined {
  const cookies = req && "cookies" in req ? req.cookies : undefined;
  if (cookies) {
    if ("getAll" in cookies && typeof cookies.getAll === "function") {
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
  // Without a request-bound configuration (D1 and signing secret) the Cal reader cannot run.
  const config = getAuthRequestConfiguration();
  if (!config) return null;
  let name = sessionCookie;
  if (config.webappURL.startsWith("https://")) name = secureSessionCookie;
  const headers = new Headers({ cookie: `${name}=${encodeURIComponent(rawToken)}` });
  return { auth: createCalRequestAuth(config), headers };
}

export async function readSessionToken(req: SessionRequest): Promise<string | null> {
  return readCookie(req, secureSessionCookie) ?? readCookie(req, sessionCookie) ?? null;
}

export async function getCalServerSession(req: SessionRequest): Promise<Session | null> {
  const rawToken = await readSessionToken(req);
  if (!rawToken) return null;
  try {
    const reader = createCalReader(rawToken);
    if (!reader) return null;
    const session = await reader.auth.api.getServerSession({ headers: reader.headers });
    if (!session) return null;
    // Session consumers expect an absent organization as undefined, not null.
    return { ...session, user: { ...session.user, org: session.user.org ?? undefined } };
  } catch {
    return null;
  }
}

export async function getCalSessionLocale(req: SessionRequest): Promise<string | null> {
  const rawToken = await readSessionToken(req);
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
