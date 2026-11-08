import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import { Authenticator } from "@otplib/core";
import { createDigest, createRandomBytes } from "@otplib/plugin-crypto";
import { keyDecoder, keyEncoder } from "@otplib/plugin-thirty-two";
import { hash } from "bcryptjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { createCalRequestAuth } from "./request-auth";

let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let auth: ReturnType<typeof createCalRequestAuth>;
const origin = "https://calflare.test";
const sessionCookie = "__Secure-better-auth.session_token";
const encryptionKey = "3".repeat(32);
const password = "Synthetic-Password-123!";
const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const backupCodes = ["11111111", "22222222", "33333333"];

const authenticator = new Authenticator({
  createDigest,
  createRandomBytes,
  keyDecoder,
  keyEncoder,
});

const users = {
  unverified: {
    id: 123,
    email: "protocol@calflare.test",
    username: "protocol",
    name: "Protocol user",
    locale: "de",
  },
  locked: { id: 124, email: "locked@calflare.test", username: "locked", name: "Locked user" },
  totp: { id: 125, email: "totp@calflare.test", username: "totp", name: "TOTP user" },
  backup: { id: 126, email: "backup@calflare.test", username: "backup", name: "Backup user" },
  weakAdmin: { id: 127, email: "weak-admin@calflare.test", username: "weak-admin", name: "Weak admin" },
  strongAdmin: {
    id: 128,
    email: "strong-admin@calflare.test",
    username: "strong-admin",
    name: "Strong admin",
  },
  oauthPassword: { id: 129, email: "google@calflare.test", username: "google", name: "Google user" },
} as const;

let passwordHash: string;
let weakPasswordHash: string;

function config(overrides: { encryptionKey?: string | undefined } = {}) {
  return {
    DB: db,
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: "synthetic-callback-test-only-secret-0123456789",
    credentialPolicy: {
      encryptionKey: "encryptionKey" in overrides ? overrides.encryptionKey : encryptionKey,
      isDevelopment: false,
      isE2E: false,
      rateLimit: "disabled" as const,
    },
  };
}

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
  passwordHash = await hash(password, 12);
  weakPasswordHash = await hash("weak-password", 12);
  auth = createCalRequestAuth(config());
}, 120_000);

type Seed = {
  id: number;
  email: string;
  username: string;
  name: string;
  locale?: string;
  role?: "USER" | "ADMIN";
  locked?: boolean;
  twoFactorEnabled?: boolean;
  twoFactorSecret?: string | null;
  backupCodes?: string | null;
  identityProvider?: "CAL" | "GOOGLE";
};

function seedUser(user: Seed) {
  return [
    db
      .prepare(
        `INSERT INTO users (id, uuid, email, username, name, locale, metadata, role, locked, twoFactorEnabled, twoFactorSecret, backupCodes, identityProvider)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        user.id,
        `uuid-${user.id}`,
        user.email,
        user.username,
        user.name,
        user.locale ?? "en",
        user.id === users.unverified.id ? '{"sessionTimeout":2}' : null,
        user.role ?? "USER",
        user.locked ? 1 : 0,
        user.twoFactorEnabled ? 1 : 0,
        user.twoFactorSecret ?? null,
        user.backupCodes ?? null,
        user.identityProvider ?? "CAL"
      ),
    db
      .prepare('INSERT INTO "UserPassword" (userId, hash) VALUES (?, ?)')
      .bind(user.id, user.id === users.weakAdmin.id ? weakPasswordHash : passwordHash),
  ];
}

beforeEach(async () => {
  await db.batch([
    db.prepare('DELETE FROM "AuthSession"'),
    db.prepare('DELETE FROM "AuthUser"'),
    db.prepare('DELETE FROM "Profile"'),
    db.prepare('DELETE FROM "Membership"'),
    db.prepare('DELETE FROM "Team"'),
    db.prepare('DELETE FROM "UserPassword"'),
    db.prepare("DELETE FROM users"),
    ...seedUser(users.unverified),
    ...seedUser({ ...users.locked, locked: true }),
    ...seedUser({
      ...users.totp,
      twoFactorEnabled: true,
      twoFactorSecret: symmetricEncrypt(totpSecret, encryptionKey),
    }),
    ...seedUser({
      ...users.backup,
      twoFactorEnabled: true,
      backupCodes: symmetricEncrypt(JSON.stringify(backupCodes), encryptionKey),
    }),
    ...seedUser({ ...users.weakAdmin, role: "ADMIN" }),
    ...seedUser({
      ...users.strongAdmin,
      role: "ADMIN",
      twoFactorEnabled: true,
      twoFactorSecret: symmetricEncrypt(totpSecret, encryptionKey),
    }),
    ...seedUser({ ...users.oauthPassword, identityProvider: "GOOGLE" }),
  ]);
});

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

function request(
  path: string,
  cookie = "",
  body?: object,
  runtime: ReturnType<typeof createCalRequestAuth> = auth
) {
  return runtime.handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, ...(body ? { origin, "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}

async function signIn(email: string, credentials: object = { password }) {
  const response = await request("sign-in/cal-credentials", "", { email, ...credentials });
  expect(response.status).toBe(200);
  const setCookie = response.headers.getSetCookie().find((value) => value.startsWith(`${sessionCookie}=`));
  expect(setCookie).toContain("HttpOnly");
  expect(setCookie).toContain("Secure");
  return { response, cookie: setCookie?.split(";")[0] ?? "" };
}

const sessions = () => db.prepare('SELECT id FROM "AuthSession"').all();
const mappings = () => db.prepare('SELECT calUserId,email FROM "AuthUser" ORDER BY calUserId').all();

describe("native credential endpoints (real authorizer, native D1 sessions)", () => {
  it("signs in an unverified Cal user and projects the browser session from D1", async () => {
    const { response, cookie } = await signIn(users.unverified.email, {
      password,
      callbackUrl: "/bookings",
    });

    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      redirect: true,
      url: `${origin}/bookings`,
      user: {
        id: users.unverified.id,
        email: users.unverified.email,
        username: users.unverified.username,
        role: "USER",
        locale: "de",
      },
    });
    expect((await mappings()).results).toEqual([
      { calUserId: users.unverified.id, email: users.unverified.email },
    ]);
    const stored = await db
      .prepare('SELECT userId,calClaims,profileContext,expiresAt FROM "AuthSession"')
      .first<{ userId: string; calClaims: string; profileContext: string | null; expiresAt: string }>();
    expect(JSON.parse(stored!.calClaims)).toMatchObject({
      id: users.unverified.id,
      email: users.unverified.email,
      role: "USER",
      locale: "de",
    });
    expect(JSON.parse(stored!.profileContext!)).toEqual({
      profileId: null,
      upId: `usr-${users.unverified.id}`,
    });
    expect(new Date(stored!.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(120_000);
  });

  it("rejects absent credentials, an unknown user and a wrong password without issuing a session", async () => {
    for (const body of [
      {},
      { email: "unknown@calflare.test", password },
      { email: users.unverified.email, password: "wrong-password" },
    ]) {
      const response = await request("sign-in/cal-credentials", "", body);
      expect(response.status).toBe(401);
      expect(await response.json()).toEqual({
        code: "INCORRECT_EMAIL_PASSWORD",
        message: "incorrect-email-password",
      });
    }
    expect((await sessions()).results).toEqual([]);
    expect((await mappings()).results).toEqual([]);
  });

  it("rejects a locked account without disclosing that it exists", async () => {
    // The shared Prisma extension excludes locked rows, so the repository lookup hides the account.
    const response = await request("sign-in/cal-credentials", "", {
      email: users.locked.email,
      password: "wrong-password",
    });
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({
      code: "INCORRECT_EMAIL_PASSWORD",
      message: "incorrect-email-password",
    });
    expect((await sessions()).results).toEqual([]);
  });

  it("verifies the password for an OAuth identity that has one", async () => {
    expect(
      (
        await request("sign-in/cal-credentials", "", {
          email: users.oauthPassword.email,
          password: "wrong-password",
        })
      ).status
    ).toBe(401);
    await expect(signIn(users.oauthPassword.email)).resolves.toMatchObject({ cookie: expect.any(String) });
  });

  it("requires a matching TOTP code and rejects a wrong one with its own code", async () => {
    const missing = await request("sign-in/cal-credentials", "", { email: users.totp.email, password });
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      code: "SECOND_FACTOR_REQUIRED",
      message: "second-factor-required",
    });

    const wrong = await request("sign-in/cal-credentials", "", {
      email: users.totp.email,
      password,
      totpCode: "000000",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      code: "INCORRECT_TWO_FACTOR_CODE",
      message: "incorrect-two-factor-code",
    });
    expect((await sessions()).results).toEqual([]);

    const valid = await signIn(users.totp.email, {
      password,
      totpCode: authenticator.generate(totpSecret),
    });
    expect(await valid.response.json()).toMatchObject({ user: { id: users.totp.id, role: "USER" } });
  });

  it("consumes a hyphen-stripped backup code once and rejects its reuse", async () => {
    const wrong = await request("sign-in/cal-credentials", "", {
      email: users.backup.email,
      password,
      backupCode: "9999-9999",
    });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({ code: "INCORRECT_BACKUP_CODE", message: "incorrect-backup-code" });

    await signIn(users.backup.email, { password, backupCode: "1111-1111" });
    const stored = await db
      .prepare("SELECT backupCodes FROM users WHERE id=?")
      .bind(users.backup.id)
      .first<{ backupCodes: string }>();
    expect(JSON.parse(symmetricDecrypt(stored!.backupCodes, encryptionKey))).toEqual([
      null,
      backupCodes[1],
      backupCodes[2],
    ]);

    const reuse = await request("sign-in/cal-credentials", "", {
      email: users.backup.email,
      password,
      backupCode: "1111-1111",
    });
    expect(reuse.status).toBe(401);
    expect(await reuse.json()).toEqual({ code: "INCORRECT_BACKUP_CODE", message: "incorrect-backup-code" });
  });

  it("projects an insecure admin as INACTIVE_ADMIN and a strong 2FA admin as ADMIN", async () => {
    const weak = await signIn(users.weakAdmin.email, { password: "weak-password" });
    expect(await weak.response.json()).toMatchObject({
      user: { id: users.weakAdmin.id, role: "INACTIVE_ADMIN", inactiveAdminReason: "both" },
    });

    const strong = await signIn(users.strongAdmin.email, {
      password,
      totpCode: authenticator.generate(totpSecret),
    });
    const strongBody = await strong.response.json();
    expect(strongBody).toMatchObject({
      user: { id: users.strongAdmin.id, role: "ADMIN" },
    });
    expect(strongBody.user).not.toHaveProperty("inactiveAdminReason");
  });

  it("hides unexpected authorizer failures behind the internal error code", async () => {
    const withoutKey = createCalRequestAuth(config({ encryptionKey: undefined }));
    const response = await request(
      "sign-in/cal-credentials",
      "",
      { email: users.totp.email, password, totpCode: authenticator.generate(totpSecret) },
      withoutKey
    );
    expect(response.status).toBe(500);
    expect(await response.json()).toMatchObject({ message: "internal-server-error" });
    expect((await sessions()).results).toEqual([]);
  });

  it("logs in, refreshes, updates only browser fields, and revokes the stored session", async () => {
    const { cookie } = await signIn(users.unverified.email);
    const response = await request("get-session", cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toContain("no-store");
    expect(await response.json()).toMatchObject({
      hasValidLicense: false,
      user: { id: users.unverified.id, role: "USER", locale: "de" },
    });
    const updated = await request("cal/update-session", cookie, {
      data: { name: "Updated", locale: "ar", role: "ADMIN", id: 999 },
    });
    const body = await updated.json();
    expect(body).toMatchObject({
      user: { id: users.unverified.id, role: "USER", name: "Updated", locale: "ar" },
    });
    expect(JSON.stringify(body)).not.toMatch(/calClaims|calUserId|password|token|twoFactorSecret/);
    const signedOut = await request("sign-out", cookie, {});
    expect(await signedOut.json()).toEqual({ success: true });
    expect(
      signedOut.headers
        .getSetCookie()
        .some((value) => value.includes("session_token=;") && value.includes("Max-Age=0"))
    ).toBe(true);
    expect((await sessions()).results).toEqual([]);
    expect(await (await request("get-session", cookie)).json()).toBeNull();
  });

  it("rejects an unauthenticated or foreign-email update without changing the session", async () => {
    const { cookie } = await signIn(users.unverified.email);
    const before = (await db.prepare('SELECT * FROM "AuthSession"').all()).results;
    expect((await request("cal/update-session", "", { data: { name: "Not allowed" } })).status).toBe(401);

    await db
      .prepare(
        "INSERT INTO users (id, uuid, email, username) VALUES (200, 'other', 'other@calflare.test', 'other')"
      )
      .run();
    const forbidden = await request("cal/update-session", cookie, {
      data: { email: "other@calflare.test" },
    });
    expect(forbidden.status).toBe(403);
    expect((await db.prepare('SELECT * FROM "AuthSession"').all()).results).toEqual(before);
  });

  it("treats tampered and expired session cookies as unauthenticated", async () => {
    const { cookie } = await signIn(users.unverified.email);
    expect(await (await request("get-session", `${cookie}tampered`)).json()).toBeNull();
    await db.prepare('UPDATE "AuthSession" SET expiresAt=?').bind("2020-01-01T00:00:00.000Z").run();
    const expired = await request("get-session", cookie);
    expect(await expired.json()).toBeNull();
    expect(expired.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
  });

  it("serves no legacy auth protocol endpoints", async () => {
    for (const legacy of ["csrf", "providers", "session", "signout", "signin"]) {
      expect((await request(legacy)).status).toBe(404);
    }
  });
});
