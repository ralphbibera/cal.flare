import { OAuthSignInService } from "@calcom/features/auth/lib/OAuthSignInService";
import { createCalRequestAuth } from "@calcom/features/auth/lib/request-auth";
import { getAuthRequestConfiguration } from "@calcom/features/auth/lib/request-context";
import type { NextApiRequest, NextApiResponse } from "next";

function toRequest(req: NextApiRequest, baseURL: string): Request {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) for (const item of value) headers.append(name, item);
    else headers.set(name, value);
  }
  const method = req.method ?? "GET";
  const url = new URL(req.url ?? "/api/auth", new URL(baseURL).origin);
  if (method === "GET" || method === "HEAD" || req.body === undefined || req.body === null)
    return new Request(url, { method, headers });
  // The Pages body parser has already consumed the stream, so the parsed value is re-serialized.
  const body = typeof req.body === "string" ? req.body : JSON.stringify(req.body);
  if (!headers.has("content-type")) headers.set("content-type", "application/json");
  headers.delete("content-length");
  return new Request(url, { method, headers, body });
}

const handler = async (req: NextApiRequest, res: NextApiResponse): Promise<void> => {
  const config = getAuthRequestConfiguration();
  if (!config) {
    res.status(500).json({ message: "Auth request binding is required" });
    return;
  }
  const response = await createCalRequestAuth({ ...config, oauthSignIn: new OAuthSignInService() }).handler(
    toRequest(req, config.baseURL)
  );
  res.statusCode = response.status;
  response.headers.forEach((value, name) => {
    if (name !== "set-cookie") res.setHeader(name, value);
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) res.setHeader("set-cookie", cookies);
  res.end(await response.text());
};

export default handler;
