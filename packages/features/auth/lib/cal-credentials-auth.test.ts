import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { authorizeCredentials } from "./authorizeCredentials";
import { createCalCredentialsAuth } from "./cal-credentials-auth";

vi.mock("./authorizeCredentials", () => ({ authorizeCredentials: vi.fn() }));

let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let auth: ReturnType<typeof createCalCredentialsAuth>;
const origin = "https://calflare.test";
const sessionCookie = "__Secure-better-auth.session_token";

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

describe("native credential endpoints (stubbed authorizer, native D1 sessions)", () => {
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

  function request(path: string, cookie = "", body?: object) {
    return auth.handler(
      new Request(`${origin}/api/auth/${path}`, {
        method: body ? "POST" : "GET",
        headers: { cookie, ...(body ? { origin, "content-type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
      })
    );
  }

  async function login() {
    await principal();
    const response = await request("sign-in/cal-credentials", "", {
      email: "protocol@calflare.test",
      password: "synthetic-password",
      callbackUrl: "/bookings",
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      redirect: true,
      url: `${origin}/bookings`,
      user: { id: 123, role: "INACTIVE_ADMIN", inactiveAdminReason: "both", locale: "de" },
    });
    expect(authorizeCredentials).toHaveBeenCalledWith({
      email: "protocol@calflare.test",
      password: "synthetic-password",
      totpCode: "",
      backupCode: "",
    });
    const cookie = response.headers.getSetCookie().find((value) => value.startsWith(`${sessionCookie}=`));
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("Secure");
    return cookie?.split(";")[0] ?? "";
  }

  it("returns credential errors without issuing a session", async () => {
    vi.mocked(authorizeCredentials).mockRejectedValue(new Error("incorrect-email-password"));
    const response = await request("sign-in/cal-credentials", "", {});
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "INCORRECT_EMAIL_PASSWORD",
      message: "incorrect-email-password",
    });
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
  });

  it("hides unexpected authorizer failures behind the internal error code", async () => {
    vi.mocked(authorizeCredentials).mockRejectedValue(new Error("D1_ERROR: no such table"));
    const response = await request("sign-in/cal-credentials", "", {});
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ message: "internal-server-error" });
  });

  it("logs in, refreshes, updates only browser fields, and revokes the stored session", async () => {
    const cookie = await login();
    const response = await request("get-session", cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      hasValidLicense: false,
      user: { id: 123, role: "INACTIVE_ADMIN", inactiveAdminReason: "both", locale: "de" },
    });
    const stored = await db.prepare('SELECT expiresAt FROM "AuthSession"').first<{ expiresAt: string }>();
    expect(new Date(stored!.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    const updated = await request("cal/update-session", cookie, {
      data: { name: "Updated", locale: "ar", role: "ADMIN", id: 999 },
    });
    const body = await updated.json();
    expect(body).toMatchObject({ user: { id: 123, role: "INACTIVE_ADMIN", name: "Updated", locale: "ar" } });
    expect(JSON.stringify(body)).not.toMatch(/calClaims|calUserId|password|token|twoFactorSecret/);
    const signedOut = await request("sign-out", cookie, {});
    expect(await signedOut.json()).toEqual({ success: true });
    expect(
      signedOut.headers
        .getSetCookie()
        .some((value) => value.includes("session_token=;") && value.includes("Max-Age=0"))
    ).toBe(true);
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
    expect(await (await request("get-session", cookie)).json()).toBeNull();
  });

  it("rejects an unauthenticated or foreign-email update without changing the session", async () => {
    const cookie = await login();
    const before = (await db.prepare('SELECT * FROM "AuthSession"').all()).results;
    expect((await request("cal/update-session", "", { data: { name: "Not allowed" } })).status).toBe(401);
    await prismock.user.create({ data: { email: "other@calflare.test", username: "other" } });
    const forbidden = await request("cal/update-session", cookie, { data: { email: "other@calflare.test" } });
    expect(forbidden.status).toBe(403);
    expect((await db.prepare('SELECT * FROM "AuthSession"').all()).results).toEqual(before);
  });

  it("treats tampered and expired session cookies as unauthenticated", async () => {
    const cookie = await login();
    expect(await (await request("get-session", `${cookie}tampered`)).json()).toBeNull();
    await db.prepare('UPDATE "AuthSession" SET expiresAt=?').bind("2020-01-01T00:00:00.000Z").run();
    const expired = await request("get-session", cookie);
    expect(await expired.json()).toBeNull();
    expect(expired.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
  });

  it("serves no legacy auth protocol endpoints", async () => {
    for (const path of ["csrf", "providers", "session", "signout", "signin"]) {
      expect((await request(path)).status).toBe(404);
    }
  });
});
