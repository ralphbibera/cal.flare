import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symmetricEncrypt } from "@calcom/lib/crypto";
import type { RuntimeStateNamespace } from "@calcom/lib/runtimeStateContext";
import { withRuntimeState } from "@calcom/lib/runtimeStateContext";
import { hash } from "bcryptjs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import type { NextApiRequest, NextApiResponse } from "next";
import { authenticator } from "otplib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import handler from "../../../../apps/web/pages/api/auth/[...nextauth]";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { getServerSession } from "./getServerSession";
import type { AuthRequestConfiguration } from "./request-context";
import { withAuthRequestEnvironment } from "./request-context";

const nextAuth = vi.hoisted(() => vi.fn());
vi.mock("next-auth", () => ({ default: nextAuth }));
vi.mock("@calcom/features/auth/lib/next-auth-options", () => ({ getOptions: () => ({ mocked: true }) }));

const origin = "https://calflare.test";
const secret = `synthetic-dispatch-secret-${"x".repeat(32)}`;
const password = "Synthetic-Password-123!";
const email = "dispatch@calflare.test";
const key = "5".repeat(32);
const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const rateLimited = /^Rate limit exceeded\. Try again in \d+ seconds\.$/;

let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let limiter: RuntimeStateNamespace;
let passwordHash: string;

function config(overrides: Partial<AuthRequestConfiguration> = {}): AuthRequestConfiguration {
  return {
    DB: db,
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: secret,
    credentialPolicy: { encryptionKey: key, isDevelopment: false, isE2E: false, rateLimit: "disabled" },
    ...overrides,
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-auth-dispatch-"));
  const persistTo = join(root, "state");
  await migrateD1({ persistTo });
  const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
  const runtimeConfig = (name: string) => ({
    name,
    compatibilityDate: worker.compatibilityDate,
    compatibilityFlags: worker.compatibilityFlags,
    manifest: {
      mainModule: "worker.js",
      modules: {
        "worker.js": { type: "esm" as const, contents: "export default {fetch(){return new Response()}}" },
      },
    },
  });
  mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(persistTo, "v3"),
    workers: [
      {
        config: {
          ...runtimeConfig(worker.name),
          env: { DB: worker.env.DB },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");

  const stdin = {
    contents: `export { RuntimeState } from "./RuntimeState";
      export default { fetch() { return new Response(); } };`,
    resolveDir: join(__dirname, "../../../lib"),
  };
  const { outputFiles } = await build({ stdin, bundle: true, format: "esm", write: false });
  const owner = "calflare-api-v2";
  const durableObject = { type: "durable-object", storage: "sqlite" } as const;
  const runtime = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(root, "runtime", "v3"),
    workers: [worker.name, owner].map((name) => ({
      config: {
        ...runtimeConfig(name),
        ...(name === owner
          ? { exports: { RuntimeState: durableObject } }
          : { env: { RUNTIME_STATE: worker.env.RUNTIME_STATE } }),
        ...(name === owner
          ? {
              manifest: {
                mainModule: "worker.js",
                modules: {
                  "worker.js": { type: "esm" as const, contents: outputFiles[0].text },
                },
              },
            }
          : {}),
      },
    })),
  });
  limiter = (await runtime.getDurableObjectNamespace(
    "RUNTIME_STATE",
    worker.name
  )) as unknown as RuntimeStateNamespace;
  passwordHash = await hash(password, 12);
}, 120_000);

beforeEach(async () => {
  nextAuth.mockReset();
  await db.batch([
    db.prepare('DELETE FROM "AuthSession"'),
    db.prepare('DELETE FROM "AuthUser"'),
    db.prepare('DELETE FROM "UserPassword"'),
    db.prepare("DELETE FROM users"),
    db
      .prepare("INSERT INTO users(id,uuid,email,username,name,metadata) VALUES(123,?,?,?,?,?)")
      .bind("dispatch-user", email, "dispatch", "Dispatch user", '{"sessionTimeout":2}'),
    db.prepare('INSERT INTO "UserPassword"(userId,hash) VALUES(123,?)').bind(passwordHash),
  ]);
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

function apiRequest(method: string, path: string, cookie = "", body?: object | URLSearchParams) {
  const url = new URL(path, origin);
  const cookies: Record<string, string> = {};
  for (const part of cookie.split("; ").filter(Boolean)) {
    const index = part.indexOf("=");
    cookies[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
  }
  return {
    method,
    url: `${url.pathname}${url.search}`,
    headers: {
      host: "calflare.test",
      ...(cookie ? { cookie } : {}),
      ...(body
        ? {
            origin,
            "content-type":
              body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json",
          }
        : {}),
    },
    query: {
      nextauth: url.pathname
        .replace(/^\/api\/auth\/?/, "")
        .split("/")
        .filter(Boolean),
    },
    cookies,
    body,
  } as unknown as NextApiRequest;
}

function apiResponse() {
  const headers = new Map<string, string | string[]>();
  let statusCode = 200;
  let body = "";
  const res = {
    get statusCode() {
      return statusCode;
    },
    set statusCode(value: number) {
      statusCode = value;
    },
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(chunk?: string) {
      body = chunk ?? "";
    },
  } as unknown as NextApiResponse;
  return {
    res,
    status: () => statusCode,
    text: () => body,
    json: () => JSON.parse(body),
    cookies: () => ((headers.get("set-cookie") as string[] | undefined) ?? []).map((c) => c.split(";")[0]),
    setCookies: () => (headers.get("set-cookie") as string[] | undefined) ?? [],
    header: (name: string) => headers.get(name.toLowerCase()),
  };
}

async function dispatch(
  settings: AuthRequestConfiguration,
  method: string,
  path: string,
  cookie = "",
  body?: object | URLSearchParams
) {
  const request = apiRequest(method, path, cookie, body);
  const response = apiResponse();
  await withAuthRequestEnvironment(settings, () => handler(request, response.res));
  return { request, response };
}

async function csrf(settings = config()) {
  const { response } = await dispatch(settings, "GET", "/api/auth/csrf");
  expect(response.status()).toBe(200);
  const { csrfToken } = z.object({ csrfToken: z.string() }).parse(response.json());
  return { csrfToken, cookie: response.cookies().join("; ") };
}

async function signIn(settings = config(), extra: Record<string, string> = {}) {
  const state = await csrf(settings);
  const { response } = await dispatch(settings, "POST", "/api/auth/callback/credentials", state.cookie, {
    email,
    password,
    csrfToken: state.csrfToken,
    callbackUrl: "/bookings",
    json: "true",
    ...extra,
  });
  const cookie = [state.cookie, ...response.cookies()].filter(Boolean).join("; ");
  return { state, response, cookie };
}

async function enableMfa() {
  await db
    .prepare("UPDATE users SET twoFactorEnabled=1,twoFactorSecret=?,backupCodes=? WHERE id=123")
    .bind(symmetricEncrypt(totpSecret, key), symmetricEncrypt('["12345678","87654321"]', key))
    .run();
}

describe("Cal auth mounted under /api/auth with real migrated D1", () => {
  it("serves CSRF through the route without invoking NextAuth", async () => {
    const { response } = await dispatch(config(), "GET", "/api/auth/csrf");
    expect(response.status()).toBe(200);
    expect(z.object({ csrfToken: z.string() }).parse(response.json()).csrfToken).toMatch(/^[a-f0-9]{64}$/);
    expect(response.cookies().some((c) => c.startsWith("__Secure-next-auth.csrf-token="))).toBe(true);
    expect(response.header("cache-control")).toContain("no-store");
    expect(nextAuth).not.toHaveBeenCalled();
  });

  it("signs credentials in, sets the session cookie and reads it back through getServerSession", async () => {
    const { response, cookie } = await signIn();
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ url: `${origin}/bookings` });
    expect(response.cookies().some((c) => c.startsWith("__Secure-next-auth.session-token="))).toBe(true);
    expect(nextAuth).not.toHaveBeenCalled();

    const request = apiRequest("GET", "/api/auth/session", cookie);
    const session = await withAuthRequestEnvironment(config(), () => getServerSession({ req: request }));
    expect(session).toMatchObject({
      hasValidLicense: true,
      user: { id: 123, email, username: "dispatch", name: "Dispatch user" },
    });
  });

  it("rejects a wrong password without issuing a session", async () => {
    const { response } = await signIn(config(), { password: "incorrect" });
    expect(response.status()).toBe(401);
    expect(response.json()).toEqual({ url: `${origin}/api/auth/error?error=incorrect-email-password` });
    expect(response.cookies().some((c) => c.startsWith("__Secure-next-auth.session-token="))).toBe(false);
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
  });

  it("requires a second factor when TOTP is enabled", async () => {
    await enableMfa();
    const { response } = await signIn();
    expect(response.status()).toBe(401);
    expect(response.json()).toEqual({ url: `${origin}/api/auth/error?error=second-factor-required` });
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);

    const signedIn = await signIn(config(), { totpCode: authenticator.generate(totpSecret) });
    expect(signedIn.response.status()).toBe(200);
    expect(signedIn.response.cookies().some((c) => c.startsWith("__Secure-next-auth.session-token="))).toBe(
      true
    );
  });

  it("enforces the rate limit through the route when enabled", async () => {
    vi.stubEnv("UNKEY_ROOT_KEY", "configured");
    await db.prepare("UPDATE users SET email=? WHERE id=123").bind(`${email}.limited`).run();
    const settings = config({
      credentialPolicy: { encryptionKey: key, isDevelopment: false, isE2E: false, rateLimit: "enabled" },
    });
    const attempt = () =>
      withRuntimeState({ RUNTIME_STATE: limiter }, () => signIn(settings, { email: `${email}.limited` }));
    for (let i = 0; i < 10; i++) expect((await attempt()).response.status()).toBe(200);
    const limited = await attempt();
    expect(limited.response.status()).toBe(401);
    const { url } = z.object({ url: z.string() }).parse(limited.response.json());
    expect(new URL(url).searchParams.get("error")).toMatch(rateLimited);
    expect(limited.response.cookies().some((c) => c.startsWith("__Secure-next-auth.session-token="))).toBe(
      false
    );
  });

  it("returns the session when signed in and an empty body when signed out", async () => {
    const signedOut = await dispatch(config(), "GET", "/api/auth/session");
    expect(signedOut.response.status()).toBe(200);
    expect(signedOut.response.json()).toEqual({});

    const { cookie } = await signIn();
    const signedIn = await dispatch(config(), "GET", "/api/auth/session", cookie);
    expect(signedIn.response.json()).toMatchObject({ user: { id: 123, email, role: "USER" } });
  });

  it("lists the credentials provider", async () => {
    const { response } = await dispatch(config(), "GET", "/api/auth/providers");
    expect(response.status()).toBe(200);
    expect(response.json()).toMatchObject({
      credentials: {
        id: "credentials",
        name: "Cal.flare",
        type: "credentials",
        signinUrl: `${origin}/api/auth/signin/credentials`,
        callbackUrl: `${origin}/api/auth/callback/credentials`,
      },
    });
  });

  it("signs out, clears the session cookie and revokes the stored session", async () => {
    const { state, cookie } = await signIn();
    const { response } = await dispatch(config(), "POST", "/api/auth/signout", cookie, {
      csrfToken: state.csrfToken,
      callbackUrl: "/auth/logout",
      json: "true",
    });
    expect(response.status()).toBe(200);
    expect(response.json()).toEqual({ url: `${origin}/auth/logout` });
    const deletion = response.setCookies().find((c) => c.startsWith("__Secure-next-auth.session-token="));
    expect(deletion).toContain("Max-Age=0");
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);

    const after = await dispatch(config(), "GET", "/api/auth/session", cookie);
    expect(after.response.json()).toEqual({});
  });

  it("redirects known errors to the sign-in page", async () => {
    const { response } = await dispatch(config(), "GET", "/api/auth/error?error=CredentialsSignin");
    expect(response.status()).toBe(302);
    expect(response.header("location")).toBe(`${origin}/api/auth/signin?error=CredentialsSignin`);
  });

  it.each([
    ["GET", "/api/auth/session"],
    ["POST", "/api/auth/signout"],
  ])("sends %s %s to Better Auth even with a next-auth cookie", async (method, path) => {
    const legacy = "__Secure-next-auth.session-token=header.key.iv.ciphertext.tag";
    await dispatch(config(), method, path, legacy);
    expect(nextAuth).not.toHaveBeenCalled();
  });

  it("keeps a non-Cal action on the existing NextAuth handler", async () => {
    const request = apiRequest("GET", "/api/auth/signin");
    const response = apiResponse();
    nextAuth.mockResolvedValueOnce(undefined);
    await handler(request, response.res);
    expect(nextAuth).toHaveBeenCalledTimes(1);
    expect(nextAuth).toHaveBeenCalledWith(request, response.res, { mocked: true });
    expect(response.status()).toBe(200);
  });
});
