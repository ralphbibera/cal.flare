import { env } from "cloudflare:workers";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";

export function fetchRewriteDestination(target: string, init: RequestInit): Promise<Response> {
  const configuredUrl = process.env.NEXT_PUBLIC_API_V2_URL;
  if (!configuredUrl) return fetch(target, init);

  const apiUrl = new URL(configuredUrl);
  const targetUrl = new URL(target);
  const apiPath = apiUrl.pathname.replace(/\/$/, "");
  if (
    targetUrl.origin !== apiUrl.origin ||
    (targetUrl.pathname !== apiPath && !targetUrl.pathname.startsWith(`${apiPath}/`))
  ) {
    return fetch(target, init);
  }

  if (!env.API_V2) {
    throw new ErrorWithCode(
      ErrorCode.InternalServerError,
      "API_V2 service binding is required for API v2 rewrites"
    );
  }
  return env.API_V2.fetch(target, init);
}
