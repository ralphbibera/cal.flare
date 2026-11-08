import qs from "qs";

function parseCookies(header: string | undefined): Record<string, string> {
  if (!header) return {};
  const cookies: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    const name = part.slice(0, separator).trim();
    if (!name) continue;
    const rawValue = part.slice(separator + 1).trim();
    try {
      cookies[name] = decodeURIComponent(rawValue);
    } catch {
      cookies[name] = rawValue;
    }
  }
  return cookies;
}

function requestIp(raw: Request): string | undefined {
  const forwarded = raw.headers.get("x-forwarded-for");
  return raw.headers.get("cf-connecting-ip") ?? forwarded?.split(",")[0]?.trim();
}

const REDIRECT_STATUS_TEXT: Readonly<Record<number, string>> = {
  301: "Moved Permanently",
  302: "Found",
  303: "See Other",
  307: "Temporary Redirect",
  308: "Permanent Redirect",
};

function serializeCookie(name: string, value: string, options: CookieOptions = {}): string {
  const parts = [`${name}=${encodeURIComponent(value)}`];
  if (options.maxAge !== undefined) parts.push(`Max-Age=${Math.floor(options.maxAge / 1000)}`);
  if (options.domain) parts.push(`Domain=${options.domain}`);
  if (options.path) parts.push(`Path=${options.path}`);
  if (options.expires) parts.push(`Expires=${options.expires.toUTCString()}`);
  if (options.httpOnly) parts.push("HttpOnly");
  if (options.secure) parts.push("Secure");
  if (options.sameSite) {
    parts.push(`SameSite=${options.sameSite.charAt(0).toUpperCase()}${options.sameSite.slice(1)}`);
  }
  return parts.join("; ");
}

class ResponseWriter implements ApiResponseWriter {
  statusCode = 200;
  readonly headers = new Headers();
  private body: string | Uint8Array | null = null;
  private sent = false;
  private readonly closeListeners: Array<() => void> = [];

  get headersSent(): boolean {
    return this.sent;
  }

  setHeader(name: string, value: number | string | readonly string[]): void {
    if (Array.isArray(value)) {
      this.headers.delete(name);
      for (const entry of value) this.headers.append(name, entry);
      return;
    }
    this.headers.set(name, String(value));
  }

  getHeader(name: string): string | undefined {
    return this.headers.get(name) ?? undefined;
  }

  getHeaders(): Record<string, string> {
    return Object.fromEntries(this.headers.entries());
  }

  removeHeader(name: string): void {
    this.headers.delete(name);
  }

  status(code: number): ApiResponse {
    this.statusCode = code;
    return this;
  }

  json(body: unknown): ApiResponse {
    if (!this.headers.has("content-type"))
      this.headers.set("content-type", "application/json; charset=utf-8");
    return this.write(JSON.stringify(body) ?? "");
  }

  send(body?: unknown): ApiResponse {
    if (body === undefined || body === null) return this.write("");
    if (typeof body === "string") {
      if (!this.headers.has("content-type")) this.headers.set("content-type", "text/html; charset=utf-8");
      return this.write(body);
    }
    if (body instanceof Uint8Array) {
      if (!this.headers.has("content-type")) this.headers.set("content-type", "application/octet-stream");
      return this.write(body);
    }
    if (typeof body === "object") return this.json(body);
    return this.send(String(body));
  }

  end(body?: unknown): ApiResponse {
    if (body === undefined || body === null) return this.write("");
    if (typeof body === "string" || body instanceof Uint8Array) return this.write(body);
    return this.send(body);
  }

  redirect(statusOrUrl: number | string, url?: string): ApiResponse {
    const statusCode = typeof statusOrUrl === "number" ? statusOrUrl : 302;
    const location = typeof statusOrUrl === "string" ? statusOrUrl : url;
    if (location === undefined) throw new Error("Redirect response requires a location");
    this.statusCode = statusCode;
    this.headers.set("location", location);
    this.headers.set("content-type", "text/html; charset=utf-8");
    const message = REDIRECT_STATUS_TEXT[statusCode] ?? "Found";
    return this.write(`${message}. Redirecting to ${location}`);
  }

  cookie(name: string, value: string, options?: CookieOptions): ApiResponse {
    this.headers.append("set-cookie", serializeCookie(name, value, options));
    return this;
  }

  clearCookie(name: string, options?: CookieOptions): ApiResponse {
    return this.cookie(name, "", { ...options, expires: new Date(1), maxAge: 0 });
  }

  on(event: "close", listener: () => void): void {
    if (event === "close") this.closeListeners.push(listener);
  }

  get(name: string): string | undefined {
    return this.getHeader(name);
  }

  toResponse(): Response {
    const status = this.statusCode;
    if (status === 204 || status === 304 || this.body === null) {
      if (status === 204 || status === 304) {
        this.headers.delete("content-type");
        this.headers.delete("content-length");
      }
      return new Response(null, { status, headers: this.headers });
    }
    const body = typeof this.body === "string" ? this.body : new Uint8Array(this.body);
    return new Response(body, { status, headers: this.headers });
  }

  runCloseListeners(): void {
    this.sent = true;
    for (const listener of this.closeListeners.splice(0)) {
      try {
        listener();
      } catch {
        // A closing listener must not replace an already written response.
      }
    }
  }

  private write(body: string | Uint8Array): ApiResponse {
    if (this.statusCode === 204 || this.statusCode === 304) {
      this.body = null;
      this.sent = true;
      return this;
    }
    this.body = body;
    this.sent = true;
    return this;
  }
}

export interface ApiRequest {
  readonly raw: Request;
  readonly method: string;
  url: string;
  readonly originalUrl: string;
  readonly baseUrl: string;
  params: Record<string, string>;
  query: Record<string, unknown>;
  body: unknown;
  rawBody?: Uint8Array;
  cookies: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  ip?: string;
  user?: unknown;
  organizationId?: number | null;
  authMethod?: string;
  team?: unknown;
  organization?: unknown;
  membership?: unknown;
  webhook?: unknown;
  allowedAuthMethods?: readonly string[];
  get(name: string): string | undefined;
}

export interface CookieOptions {
  path?: string;
  domain?: string;
  maxAge?: number;
  expires?: Date;
  httpOnly?: boolean;
  secure?: boolean;
  sameSite?: "lax" | "strict" | "none";
}

export interface ApiResponse {
  statusCode: number;
  readonly headers: Headers;
  readonly headersSent: boolean;
  setHeader(name: string, value: number | string | readonly string[]): void;
  getHeader(name: string): string | undefined;
  getHeaders(): Record<string, string>;
  removeHeader(name: string): void;
  status(code: number): ApiResponse;
  json(body: unknown): ApiResponse;
  send(body?: unknown): ApiResponse;
  end(body?: unknown): ApiResponse;
  redirect(statusOrUrl: number | string, url?: string): ApiResponse;
  cookie(name: string, value: string, options?: CookieOptions): ApiResponse;
  clearCookie(name: string, options?: CookieOptions): ApiResponse;
  on(event: "close", listener: () => void): void;
  get(name: string): string | undefined;
}

export interface ApiResponseWriter extends ApiResponse {
  toResponse(): Response;
  runCloseListeners(): void;
}

export function createRequest({
  raw,
  params,
  originalUrl,
}: {
  raw: Request;
  params: Record<string, string>;
  originalUrl: string;
}): ApiRequest {
  const url = new URL(raw.url);
  const headers: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of raw.headers.entries()) headers[name] = value;
  return {
    raw,
    method: raw.method,
    url: `${url.pathname}${url.search}`,
    originalUrl,
    baseUrl: "",
    params,
    query: qs.parse(url.search.slice(1), { arrayLimit: 1000 }),
    body: undefined,
    cookies: parseCookies(typeof headers.cookie === "string" ? headers.cookie : undefined),
    headers,
    ip: requestIp(raw),
    get(name: string): string | undefined {
      return raw.headers.get(name) ?? undefined;
    },
  };
}

export function createResponse(): ApiResponseWriter {
  return new ResponseWriter();
}
