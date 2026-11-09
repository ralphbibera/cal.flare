import { SESSION_MAX_AGE } from "@calcom/features/auth/lib/cal-session";
import { createCalRequestAuth } from "@calcom/features/auth/lib/request-auth";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { hash } from "bcryptjs";
import { describe, expect } from "vitest";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../apps/web/cloudflare.config")).default.worker,
});

const origin = "https://calflare.test";
const sessionCookie = "__Secure-better-auth.session_token";
const password = "Synthetic-Password-123!";
const timedUser = { id: 61, email: "timed@calflare.test", sessionTimeout: 2 };
const defaultUser = { id: 62, email: "default@calflare.test" };

let passwordHash: string;

const config = () => ({
  DB: d1.db,
  baseURL: origin,
  webappURL: origin,
  NEXTAUTH_SECRET: "synthetic-session-expiry-test-only-secret-0123456789",
  credentialPolicy: {
    encryptionKey: "4".repeat(32),
    isDevelopment: false,
    isE2E: false,
    rateLimit: "disabled" as const,
  },
});

const auth = () => createCalRequestAuth(config());

async function signIn(email: string) {
  const response = await auth().handler(
    new Request(`${origin}/api/auth/sign-in/cal-credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password }),
    })
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${sessionCookie}=`))
    ?.split(";")[0];
  if (!cookie) throw new Error("The credential sign-in did not issue a session cookie");
  return cookie;
}

const getSession = (cookie: string) =>
  auth().handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }));

const storedExpiry = async () =>
  (await d1.db.prepare('SELECT expiresAt FROM "AuthSession"').first<{ expiresAt: string }>())!.expiresAt;

const setExpiry = (expiresAt: Date) =>
  d1.db.prepare('UPDATE "AuthSession" SET expiresAt = ?').bind(expiresAt.toISOString()).run();

d1.beforeAll(async () => {
  passwordHash = await hash(password, 12);
}, 60_000);

d1.beforeEach(async () => {
  await d1.db.batch([
    d1.db.prepare('DELETE FROM "AuthSession"'),
    d1.db.prepare('DELETE FROM "AuthUser"'),
    d1.db.prepare('DELETE FROM "UserPassword"'),
    d1.db.prepare("DELETE FROM users"),
    d1.db
      .prepare(
        `INSERT INTO users (id, uuid, email, username, metadata, emailVerified, identityProvider)
         VALUES (?, 'timed-user', ?, 'timed', ?, '2026-01-01T00:00:00.000Z', 'CAL')`
      )
      .bind(timedUser.id, timedUser.email, JSON.stringify({ sessionTimeout: timedUser.sessionTimeout })),
    d1.db
      .prepare(
        `INSERT INTO users (id, uuid, email, username, metadata, emailVerified, identityProvider)
         VALUES (?, 'default-user', ?, 'default', NULL, '2026-01-01T00:00:00.000Z', 'CAL')`
      )
      .bind(defaultUser.id, defaultUser.email),
    d1.db.prepare('INSERT INTO "UserPassword" (userId, hash) VALUES (?, ?)').bind(timedUser.id, passwordHash),
    d1.db
      .prepare('INSERT INTO "UserPassword" (userId, hash) VALUES (?, ?)')
      .bind(defaultUser.id, passwordHash),
  ]);
});

describe("Cal session expiry and refresh on D1", () => {
  d1.it("issues a session that expires after the configured per-user timeout", async () => {
    const before = Date.now();
    await signIn(timedUser.email);

    const remaining = new Date(await storedExpiry()).getTime() - before;
    expect(remaining).toBeGreaterThan((timedUser.sessionTimeout * 60 - 10) * 1000);
    expect(remaining).toBeLessThan((timedUser.sessionTimeout * 60 + 10) * 1000);
  });

  d1.it("rejects an expired session and clears the browser cookie", async () => {
    const cookie = await signIn(timedUser.email);
    await setExpiry(new Date("2020-01-01T00:00:00.000Z"));

    const response = await getSession(cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toBeNull();
    expect(
      response.headers
        .getSetCookie()
        .some((value) => value.startsWith(`${sessionCookie}=`) && value.includes("Max-Age=0"))
    ).toBe(true);
  });

  d1.it("renews a valid session to the configured per-user timeout", async () => {
    const cookie = await signIn(timedUser.email);
    await setExpiry(new Date(Date.now() + 30_000));

    const response = await getSession(cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ user: { id: timedUser.id, email: timedUser.email } });
    const renewed = new Date(await storedExpiry()).getTime() - Date.now();
    expect(renewed).toBeGreaterThan((timedUser.sessionTimeout * 60 - 10) * 1000);
    expect(response.headers.getSetCookie().some((value) => value.startsWith(`${sessionCookie}=`))).toBe(true);
  });

  d1.it("renews a session with no override to the default maximum age", async () => {
    const before = Date.now();
    const cookie = await signIn(defaultUser.email);
    const issued = new Date(await storedExpiry()).getTime() - before;
    expect(issued).toBeGreaterThan((SESSION_MAX_AGE - 10) * 1000);
    expect(issued).toBeLessThan((SESSION_MAX_AGE + 10) * 1000);

    await setExpiry(new Date(Date.now() + 30_000));
    const response = await getSession(cookie);

    expect(await response.json()).toMatchObject({ user: { id: defaultUser.id } });
    const renewed = new Date(await storedExpiry()).getTime() - Date.now();
    expect(renewed).toBeGreaterThan((SESSION_MAX_AGE - 10) * 1000);
    expect(renewed).toBeLessThan((SESSION_MAX_AGE + 10) * 1000);
  });

  d1.it("does not renew a revoked session", async () => {
    const cookie = await signIn(timedUser.email);
    await d1.db.prepare('DELETE FROM "AuthSession"').run();

    const response = await getSession(cookie);

    expect(await response.json()).toBeNull();
    expect(await d1.db.prepare('SELECT id FROM "AuthSession"').all()).toMatchObject({ results: [] });
  });
});
