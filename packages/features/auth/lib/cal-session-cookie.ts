import type { IncomingHttpHeaders } from "node:http";
import type { GetServerSidePropsContext } from "next";
import type { NextRequest } from "next/server";
import type { CalServerSession } from "./cal-server-session";
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

function serializeCookies(
  cookies: NonNullable<Extract<SessionRequest, { cookies?: unknown }>["cookies"]>
): string {
  const pairs =
    "getAll" in cookies && typeof cookies.getAll === "function"
      ? cookies.getAll().map(({ name, value }) => [name, value] as const)
      : cookies instanceof Map
        ? Array.from(cookies.entries())
        : Object.entries(cookies as Partial<Record<string, string>>);
  return pairs
    .filter((pair): pair is readonly [string, string] => typeof pair[1] === "string")
    .map(([name, value]) => `${name}=${encodeURIComponent(value)}`)
    .join("; ");
}

// Forward the request's cookies unchanged so Better Auth finds its own session cookie by its configured name.
function cookieHeader(req: SessionRequest): string | null {
  if (!req) return null;
  const header = req.headers instanceof Headers ? req.headers.get("cookie") : req.headers?.cookie;
  if (typeof header === "string" && header) return header;
  const cookies = "cookies" in req ? req.cookies : undefined;
  return cookies ? serializeCookies(cookies) || null : null;
}

type CalReader = { auth: ReturnType<typeof createCalRequestAuth>; headers: Headers };

function createCalReader(req: SessionRequest): CalReader | null {
  const cookie = cookieHeader(req);
  if (!cookie) return null;
  // Without a request-bound configuration (D1 and signing secret) the Cal reader cannot run.
  const config = getAuthRequestConfiguration();
  if (!config) return null;
  return { auth: createCalRequestAuth(config), headers: new Headers({ cookie }) };
}

export async function getCalServerSession(req: SessionRequest): Promise<CalServerSession | null> {
  try {
    const reader = createCalReader(req);
    if (!reader) return null;
    return await reader.auth.api.getServerSession({ headers: reader.headers });
  } catch {
    return null;
  }
}

export async function getCalSessionLocale(req: SessionRequest): Promise<string | null> {
  try {
    const reader = createCalReader(req);
    if (!reader) return null;
    const session = await reader.auth.api.getSessionClaims({ headers: reader.headers });
    return session?.claims.locale ?? null;
  } catch {
    return null;
  }
}
