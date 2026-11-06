import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { authorizeCredentials } from "./authorizeCredentials";
import { createCalCredentialsAuth } from "./cal-credentials-auth";

vi.mock("./authorizeCredentials", () => ({ authorizeCredentials: vi.fn() }));

let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let auth: ReturnType<typeof createCalCredentialsAuth>;
const origin = "https://calflare.test";
const cookieName = "__Secure-next-auth.callback-url";

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-protocol-test-"));
  const persistTo = join(root, "state");
  await migrateD1({ persistTo });
  const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
  mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(persistTo, "v3"),
    workers: [
      {
        config: {
          name: worker.name,
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          env: { DB: worker.env.DB },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": {
                type: "esm",
                contents: "export default { fetch() { return new Response(); } };",
              },
            },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
  auth = createCalCredentialsAuth({
    DB: db,
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: "synthetic-callback-test-only-secret-0123456789",
  });
}, 120_000);

beforeEach(async () => {
  vi.mocked(authorizeCredentials).mockReset();
  await db.prepare('DELETE FROM "AuthUser"').run();
  await db.prepare("DELETE FROM users").run();
});

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

describe("credential HTTP protocol (stubbed authorizer, native D1 sessions)", () => {
  async function principal() {
    await prismock.user.create({
      data: {
        id: 123,
        email: "protocol@calflare.test",
        username: "protocol",
        name: "Protocol user",
        createdDate: new Date(),
        locale: "de",
        metadata: { sessionTimeout: 2 },
      },
    });
    await db
      .prepare("INSERT INTO users(id,uuid,email) VALUES(123,'protocol-user','protocol@calflare.test')")
      .run();
    const user = await new UserRepository(prismock).findByEmailAndIncludeProfilesAndPassword({
      email: "protocol@calflare.test",
    });
    if (!user) throw new Error("Protocol principal was not created");
    vi.mocked(authorizeCredentials).mockResolvedValue({
      ...user,
      role: "INACTIVE_ADMIN",
      inactiveAdminReason: "both",
      belongsToActiveTeam: false,
      profile: user.allProfiles[0],
    });
  }

  async function request(path: string, cookie = "", body?: object | URLSearchParams) {
    return auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: body ? "POST" : "GET",
        headers: {
          cookie,
          ...(body
            ? {
                origin,
                "content-type":
                  body instanceof URLSearchParams ? "application/x-www-form-urlencoded" : "application/json",
              }
            : {}),
        },
        ...(body ? { body: body instanceof URLSearchParams ? body : JSON.stringify(body) } : {}),
      })
    );
  }

  async function csrf() {
    const response = await request("csrf");
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    const { csrfToken } = z.object({ csrfToken: z.string() }).parse(await response.json());
    const cookie = response.headers
      .getSetCookie()
      .map((value) => value.split(";")[0])
      .join("; ");
    return { csrfToken, cookie };
  }

  async function login() {
    await principal();
    const state = await csrf();
    const response = await request(
      "callback/credentials",
      state.cookie,
      new URLSearchParams({
        csrfToken: state.csrfToken,
        email: "protocol@calflare.test",
        password: "synthetic-password",
        callbackUrl: "/bookings",
        json: "true",
      })
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ url: `${origin}/bookings` });
    expect(authorizeCredentials).toHaveBeenCalledWith({
      email: "protocol@calflare.test",
      password: "synthetic-password",
      totpCode: "",
      backupCode: "",
      csrfToken: state.csrfToken,
      callbackUrl: "/bookings",
      json: "true",
    });
    const sessionCookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith("__Secure-next-auth.session-token="));
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("Secure");
    return { ...state, cookie: `${state.cookie}; ${sessionCookie?.split(";")[0]}` };
  }

  it("rejects missing and tampered CSRF before authorizing credentials", async () => {
    const state = await csrf();
    for (const csrfToken of [undefined, `${state.csrfToken}tampered`]) {
      const response = await request("callback/credentials", state.cookie, { csrfToken, json: "true" });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ url: `${origin}/api/auth/signin?csrf=true` });
    }
    expect(authorizeCredentials).not.toHaveBeenCalled();
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
  });

  it("returns credential errors without issuing a session", async () => {
    const state = await csrf();
    vi.mocked(authorizeCredentials).mockRejectedValue(new Error("incorrect-email-password"));
    const response = await request("callback/credentials", state.cookie, {
      csrfToken: state.csrfToken,
      json: "true",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ url: `${origin}/api/auth/error?error=incorrect-email-password` });
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
  });

  it("logs in, refreshes, updates only browser fields, and revokes the stored session", async () => {
    const state = await login();
    const response = await request("session", state.cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      hasValidLicense: false,
      user: { id: 123, role: "INACTIVE_ADMIN", inactiveAdminReason: "both", locale: "de" },
    });
    const stored = await db.prepare('SELECT expiresAt FROM "AuthSession"').first<{ expiresAt: string }>();
    expect(new Date(stored!.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    const updated = await request("session", state.cookie, {
      csrfToken: state.csrfToken,
      data: { name: "Updated", locale: "ar", role: "ADMIN", id: 999 },
    });
    const body = await updated.json();
    expect(body).toMatchObject({ user: { id: 123, role: "INACTIVE_ADMIN", name: "Updated", locale: "ar" } });
    expect(JSON.stringify(body)).not.toMatch(/calClaims|calUserId|password|token|twoFactorSecret/);
    const signedOut = await request(
      "signout",
      state.cookie,
      new URLSearchParams({
        csrfToken: state.csrfToken,
        json: "true",
        callbackUrl: "/auth/login",
      })
    );
    expect(await signedOut.json()).toEqual({ url: `${origin}/auth/login` });
    expect(
      signedOut.headers
        .getSetCookie()
        .some((cookie) => cookie.includes("session-token=;") && cookie.includes("Max-Age=0"))
    ).toBe(true);
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
    expect(await (await request("session", state.cookie)).json()).toEqual({});
  });

  it("does not mutate or revoke a session without CSRF and rejects a foreign email update", async () => {
    const state = await login();
    const before = (await db.prepare('SELECT * FROM "AuthSession"').all()).results;
    expect((await request("session", state.cookie, { data: { name: "Not allowed" } })).status).toBe(400);
    expect(await (await request("signout", state.cookie, { json: "true" })).json()).toEqual({
      url: `${origin}/api/auth/signout?csrf=true`,
    });
    await prismock.user.create({ data: { email: "other@calflare.test", username: "other" } });
    const forbidden = await request("session", state.cookie, {
      csrfToken: state.csrfToken,
      data: { email: "other@calflare.test" },
    });
    expect(forbidden.status).toBe(403);
    expect(await forbidden.json()).toEqual({});
    expect((await db.prepare('SELECT * FROM "AuthSession"').all()).results).toEqual(before);
  });

  it("treats tampered and expired session cookies as unauthenticated", async () => {
    const state = await login();
    expect(await (await request("session", `${state.cookie}tampered`)).json()).toEqual({});
    await db.prepare('UPDATE "AuthSession" SET expiresAt=?').bind("2020-01-01T00:00:00.000Z").run();
    const expired = await request("session", state.cookie);
    expect(await expired.json()).toEqual({});
    expect(expired.headers.getSetCookie().some((cookie) => cookie.includes("Max-Age=0"))).toBe(true);
  });
});

it.each([
  ["/bookings", `${origin}/bookings`],
  ["https://calflare.test:9443/bookings", "https://calflare.test:9443/bookings"],
  ["http://calflare.test/bookings", "http://calflare.test/bookings"],
  ["https://other.test/bookings", origin],
  ["ftp://calflare.test/bookings", origin],
  ["file://calflare.test/bookings", origin],
  ["invalid URL", origin],
])("validates query and cookie callback %s before navigation", async (target, expected) => {
  for (const source of ["query", "cookie"]) {
    const query = source === "query" ? `?callbackUrl=${encodeURIComponent(target)}` : "";
    const response = await auth.handler(
      new Request(`${origin}/api/auth/signin${query}`, {
        headers: source === "cookie" ? { cookie: `${cookieName}=${encodeURIComponent(target)}` } : {},
      })
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(`/auth/login?callbackUrl=${encodeURIComponent(expected)}`);
    const stored = response.headers.getSetCookie().find((cookie) => cookie.startsWith(`${cookieName}=`));
    if (target !== expected || source === "query") {
      expect(stored?.split(";")[0]).toBe(`${cookieName}=${encodeURIComponent(expected)}`);
    }
  }
});
