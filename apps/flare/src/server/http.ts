import type { APIContext, APIRoute } from "astro";

export class ErrorWithCode extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status = 400, message = code) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" },
  });
}

export function endpoint(handler: (context: APIContext) => Promise<Response>): APIRoute {
  return (context: APIContext) => respond(context.request, () => handler(context));
}

export async function respond(request: Request, handler: () => Promise<Response>): Promise<Response> {
  try {
    return await handler();
  } catch (error) {
    if (error instanceof ErrorWithCode) {
      return json({ error: error.code, message: error.message }, error.status);
    }
    if (error instanceof Error && "code" in error && typeof error.code === "string") {
      let status = 400;
      if (error.code === "FORBIDDEN" || error.code === "ORIGIN") status = 403;
      if (
        [
          "CONFIGURATION",
          "GOOGLE_CALENDAR",
          "GOOGLE_DISCONNECTED",
          "TOKEN_STORAGE",
          "TOKEN_RACE",
          "TOKEN_NETWORK",
          "OAUTH_IDENTITY",
          "UPSTREAM_SHAPE",
          "OAUTH_EXCHANGE",
        ].includes(error.code)
      )
        status = 503;
      return json({ error: error.code }, status);
    }
    if (error instanceof RangeError) return json({ error: "invalid_range" }, 400);
    console.error(JSON.stringify({ event: "request_failed", path: new URL(request.url).pathname }));
    return json({ error: "temporarily_unavailable" }, 503);
  }
}

export function sameOrigin(request: Request, origin: string): void {
  if (request.headers.get("Origin") !== new URL(origin).origin) {
    throw new ErrorWithCode("invalid_origin", 403);
  }
}

export async function body(request: Request): Promise<unknown> {
  if (request.headers.get("Content-Type")?.split(";")[0].trim().toLowerCase() !== "application/json") {
    throw new ErrorWithCode("json_required", 415);
  }
  const reader = request.body?.getReader();
  if (!reader) throw new ErrorWithCode("invalid_json");
  let text = "";
  let size = 0;
  const decoder = new TextDecoder("utf-8", { fatal: true });
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > 32768) {
        await reader.cancel();
        throw new ErrorWithCode("request_too_large", 413);
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return JSON.parse(text);
  } catch (error) {
    await reader.cancel().catch(() => {});
    if (error instanceof ErrorWithCode) throw error;
    throw new ErrorWithCode("invalid_json");
  } finally {
    reader.releaseLock();
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new ErrorWithCode("invalid_input");
  }
  return Object.fromEntries(Object.entries(value));
}

export function bearer(request: Request): string {
  const authorization = request.headers.get("Authorization");
  if (!authorization?.startsWith("Bearer ")) throw new ErrorWithCode("unauthorized", 401);
  const token = authorization.slice(7);
  if (token.length < 32 || token.length > 256) throw new ErrorWithCode("unauthorized", 401);
  return token;
}
