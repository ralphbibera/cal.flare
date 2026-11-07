import type { NextApiRequest, NextApiResponse } from "next";
import { createCalRequestAuth } from "./request-auth";
import type { AuthRequestConfiguration } from "./request-context";
import { getAuthRequestConfiguration } from "./request-context";

const CAL_AUTH_ACTIONS = [
  "callback/credentials",
  "csrf",
  "session",
  "providers",
  "signout",
  "error",
] as const;

function routesToCalAuth(nextauth: string | string[] | undefined): boolean {
  if (!nextauth) return false;
  const action = Array.isArray(nextauth) ? nextauth.join("/") : nextauth;
  return (CAL_AUTH_ACTIONS as readonly string[]).includes(action);
}

function headersFrom(req: NextApiRequest): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers ?? {})) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, String(value));
  }
  return headers;
}

function bodyFrom(req: NextApiRequest, headers: Headers): BodyInit | undefined {
  const body: unknown = req.body;
  if (body === undefined || body === null) return undefined;
  if (typeof body === "string") return body;
  if (
    body instanceof URLSearchParams ||
    body instanceof Blob ||
    body instanceof FormData ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body)
  ) {
    if (body instanceof URLSearchParams && !headers.has("content-type"))
      headers.set("content-type", "application/x-www-form-urlencoded");
    return body as BodyInit;
  }
  if ((headers.get("content-type") ?? "").includes("application/x-www-form-urlencoded")) {
    const params = new URLSearchParams();
    for (const [name, value] of Object.entries(body as Record<string, unknown>)) {
      if (value === undefined) continue;
      if (Array.isArray(value)) for (const item of value) params.append(name, String(item));
      else params.append(name, String(value));
    }
    return params;
  }
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  return JSON.stringify(body);
}

function toRequest(req: NextApiRequest, config: AuthRequestConfiguration): Request {
  const headers = headersFrom(req);
  const origin = new URL(config.baseURL).origin;
  const target = req.url ?? `/api/auth/${CAL_AUTH_ACTIONS[0]}`;
  const method = req.method ?? "GET";
  const body = method === "GET" || method === "HEAD" ? undefined : bodyFrom(req, headers);
  return new Request(new URL(target, origin), { method, headers, ...(body === undefined ? {} : { body }) });
}

async function writeResponse(response: Response, res: NextApiResponse): Promise<void> {
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  const body = await response.text();
  if (body) res.end(body);
  else res.end();
}

/**
 * Adapts the Pages Router's request/response pair to the Cal auth fetch handler.
 * Returns false when no request-bound Cal configuration exists so the caller keeps NextAuth.
 */
export async function handleCalAuth(req: NextApiRequest, res: NextApiResponse): Promise<boolean> {
  if (!routesToCalAuth(req.query?.nextauth)) return false;
  const config = getAuthRequestConfiguration();
  if (!config) return false;
  const response = await createCalRequestAuth(config).handler(toRequest(req, config));
  await writeResponse(response, res);
  return true;
}

export { CAL_AUTH_ACTIONS, routesToCalAuth };
