import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { createCalRequestAuth } from "@calcom/features/auth/lib/request-auth";
import { withAuthRequestEnvironment } from "@calcom/features/auth/lib/request-context";
import { symmetricDecrypt } from "@calcom/lib/crypto";
import { Authenticator } from "@otplib/core";
import { createDigest, createRandomBytes } from "@otplib/plugin-crypto";
import { keyDecoder, keyEncoder } from "@otplib/plugin-thirty-two";
import { hash } from "bcryptjs";
import { Miniflare } from "miniflare";
import { NextRequest } from "next/server";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, vi } from "vitest";
import { POST as disableTwoFactor } from "./disable/route";
import { POST as enableTwoFactor } from "./enable/route";
import { POST as setupTwoFactor } from "./setup/route";

const requestState = vi.hoisted(() => ({ cookie: "" }));

vi.mock("next/headers", () => ({
  headers: async () => new Headers(requestState.cookie ? { cookie: requestState.cookie } : {}),
  cookies: async () => ({
    getAll: () =>
      requestState.cookie
        .split("; ")
        .filter(Boolean)
        .map((pair) => {
          const [name, ...value] = pair.split("=");
          return { name, value: value.join("=") };
        }),
  }),
}));

let root: string;
let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

const origin = "https://calflare.test";
const sessionCookie = "__Secure-better-auth.session_token";
const encryptionKey = "2".repeat(32);
const password = "Synthetic-Password-123!";
const email = "two-factor@calflare.test";
const userId = 41;

const authenticator = new Authenticator({
  createDigest,
  createRandomBytes,
  keyDecoder,
  keyEncoder,
});

let passwordHash: string;

const config = () => ({
  DB: db,
  baseURL: origin,
  webappURL: origin,
  NEXTAUTH_SECRET: "synthetic-two-factor-test-only-secret-0123456789",
  credentialPolicy: {
    encryptionKey,
    isDevelopment: false,
    isE2E: false,
    rateLimit: "disabled" as const,
  },
});

const auth = () => createCalRequestAuth(config());

function credentialSignIn(credentials: object = {}) {
  return auth().handler(
    new Request(`${origin}/api/auth/sign-in/cal-credentials`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ email, password, ...credentials }),
    })
  );
}

async function signIn() {
  const response = await credentialSignIn();
  expect(response.status).toBe(200);
  const cookie = response.headers
    .getSetCookie()
    .find((value) => value.startsWith(`${sessionCookie}=`))
    ?.split(";")[0];
  if (!cookie) throw new Error("The credential sign-in did not issue a session cookie");
  return cookie;
}

function request(path: string, body: object) {
  return new NextRequest(`${origin}/api/auth/two-factor/totp/${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function call(path: string, handler: typeof setupTwoFactor, body: object) {
  return withAuthRequestEnvironment(config(), () =>
    handler(request(path, body), { params: Promise.resolve({}) })
  );
}

const setup = (body: object) => call("setup", setupTwoFactor, body);
const enable = (body: object) => call("enable", enableTwoFactor, body);
const disable = (body: object) => call("disable", disableTwoFactor, body);

const sessions = () => db.prepare('SELECT id FROM "AuthSession"').all();

const user = () =>
  db
    .prepare(
      'SELECT "twoFactorEnabled", "twoFactorSecret", "backupCodes", "identityProvider" FROM users WHERE id = ?'
    )
    .bind(userId)
    .first<{
      twoFactorEnabled: number;
      twoFactorSecret: string | null;
      backupCodes: string | null;
      identityProvider: string;
    }>();

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-two-factor-"));
  const persistTo = join(root, "state");
  // The Vitest global setup migrated a template; copying it keeps the Node-only migration module out of the web type-check project.
  const template = process.env.CALFLARE_D1_TEMPLATE;
  if (!template) throw new Error("The Vitest global setup did not build a D1 template");
  await cp(template, persistTo, { recursive: true });
  runtime = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(persistTo, "v3"),
    workers: [
      {
        config: {
          name: "calflare-web",
          compatibilityDate: "2026-11-04",
          compatibilityFlags: ["nodejs_compat"],
          env: { DB: { type: "d1", name: "calflare" } },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
            },
          },
        },
      },
    ],
  });
  db = await runtime.getD1Database("DB");
  passwordHash = await hash(password, 12);
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  vi.stubEnv("CALENDSO_ENCRYPTION_KEY", encryptionKey);
  await db.batch([
    db.prepare('DELETE FROM "AuthSession"'),
    db.prepare('DELETE FROM "AuthUser"'),
    db.prepare('DELETE FROM "Profile"'),
    db.prepare('DELETE FROM "Membership"'),
    db.prepare('DELETE FROM "UserPassword"'),
    db.prepare("DELETE FROM users"),
    db
      .prepare(
        `INSERT INTO users (id, uuid, email, username, name, identityProvider, twoFactorEnabled)
         VALUES (?, 'two-factor', ?, 'two-factor', 'Two Factor', 'CAL', 0)`
      )
      .bind(userId, email),
    db.prepare('INSERT INTO "UserPassword" (userId, hash) VALUES (?, ?)').bind(userId, passwordHash),
  ]);
  requestState.cookie = await signIn();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("two-factor setup on D1", () => {
  it("stores an encrypted secret and backup codes and returns the QR payload", async () => {
    const response = await setup({ password });

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      secret: expect.stringMatching(/^[A-Z2-7]{32}$/),
      keyUri: expect.stringMatching(/^otpauth:\/\/totp\/Cal:two-factor%40calflare\.test\?secret=/),
      dataUri: expect.stringMatching(/^data:image\/png;base64,/),
      backupCodes: expect.arrayContaining([expect.stringMatching(/^[0-9a-f]{10}$/)]),
    });
    expect(body.backupCodes).toHaveLength(10);
    const stored = await user();
    expect(stored).toMatchObject({ twoFactorEnabled: 0 });
    expect(symmetricDecrypt(stored!.twoFactorSecret!, encryptionKey)).toBe(body.secret);
    expect(JSON.parse(symmetricDecrypt(stored!.backupCodes!, encryptionKey))).toEqual(body.backupCodes);
  });

  it("rejects an unauthenticated setup without changing the user", async () => {
    requestState.cookie = "";
    const before = await user();

    const response = await setup({ password });

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ message: "Not authenticated" });
    expect(await user()).toEqual(before);
  });

  it("rejects a wrong password and an already-enabled account", async () => {
    const wrong = await setup({ password: "wrong-password" });
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toEqual({ error: "incorrect-password" });
    expect((await user())?.twoFactorSecret).toBeNull();

    await db.prepare("UPDATE users SET twoFactorEnabled = 1 WHERE id = ?").bind(userId).run();
    const enabled = await setup({ password });
    expect(enabled.status).toBe(400);
    expect(await enabled.json()).toEqual({ error: "two-factor-already-enabled" });
  });

  it("rejects a third-party identity that has no password", async () => {
    await db.prepare("UPDATE users SET identityProvider = 'GOOGLE' WHERE id = ?").bind(userId).run();
    await db.prepare('DELETE FROM "UserPassword" WHERE userId = ?').bind(userId).run();

    const response = await setup({ password });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "third-party-identity-provider-enabled" });
  });
});

describe("two-factor enable on D1", () => {
  let secret: string;

  beforeEach(async () => {
    const response = await setup({ password });
    secret = (await response.json()).secret;
  });

  it("enables two-factor with a valid TOTP code", async () => {
    const response = await enable({ code: authenticator.generate(secret) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Two-factor enabled" });
    expect(await user()).toMatchObject({
      twoFactorEnabled: 1,
      twoFactorSecret: expect.any(String),
    });
  });

  it("rejects an invalid code without enabling two-factor", async () => {
    const response = await enable({ code: "000000" });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "incorrect-two-factor-code" });
    expect((await user())?.twoFactorEnabled).toBe(0);
  });

  it("requires a setup secret before a code can enable two-factor", async () => {
    await db.prepare("UPDATE users SET twoFactorSecret = NULL WHERE id = ?").bind(userId).run();

    const response = await enable({ code: authenticator.generate(secret) });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "two-factor-setup-required" });
  });
});

describe("two-factor disable on D1", () => {
  let secret: string;

  beforeEach(async () => {
    const setupResponse = await setup({ password });
    secret = (await setupResponse.json()).secret;
    const enabled = await enable({ code: authenticator.generate(secret) });
    expect(enabled.status).toBe(200);
  });

  it("disables two-factor with the password and a valid TOTP code", async () => {
    const response = await disable({ password, code: authenticator.generate(secret) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ message: "Two factor disabled" });
    expect(await user()).toMatchObject({
      twoFactorEnabled: 0,
      twoFactorSecret: null,
      backupCodes: null,
    });
  });

  it("rejects a wrong password and a wrong code without clearing the factor", async () => {
    const wrongPassword = await disable({ password: "wrong-password", code: "000000" });
    expect(wrongPassword.status).toBe(400);
    expect(await wrongPassword.json()).toEqual({ error: "incorrect-password" });
    expect((await user())?.twoFactorEnabled).toBe(1);

    const wrongCode = await disable({ password, code: "000000" });
    expect(wrongCode.status).toBe(400);
    expect(await wrongCode.json()).toEqual({ error: "incorrect-two-factor-code" });
    expect((await user())?.twoFactorEnabled).toBe(1);
  });

  it("requires the second factor before disabling", async () => {
    const response = await disable({ password });

    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "second-factor-required" });
    expect((await user())?.twoFactorEnabled).toBe(1);
  });
});

describe("two-factor login on D1", () => {
  let secret: string;
  let backupCodes: string[];

  beforeEach(async () => {
    const setupResponse = await setup({ password });
    const body = await setupResponse.json();
    secret = body.secret;
    backupCodes = body.backupCodes;
    const enabled = await enable({ code: authenticator.generate(secret) });
    expect(enabled.status).toBe(200);
  });

  it("challenges a password-only login and accepts the matching TOTP code", async () => {
    const missing = await credentialSignIn();
    expect(missing.status).toBe(401);
    expect(await missing.json()).toEqual({
      code: "SECOND_FACTOR_REQUIRED",
      message: "second-factor-required",
    });

    const wrong = await credentialSignIn({ totpCode: "000000" });
    expect(wrong.status).toBe(401);
    expect(await wrong.json()).toEqual({
      code: "INCORRECT_TWO_FACTOR_CODE",
      message: "incorrect-two-factor-code",
    });
    expect(await sessions()).toMatchObject({ results: [{ id: expect.any(String) }] });

    const valid = await credentialSignIn({ totpCode: authenticator.generate(secret) });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ user: { id: userId } });
    expect(await sessions()).toMatchObject({
      results: [{ id: expect.any(String) }, { id: expect.any(String) }],
    });
  });

  it("consumes a backup code once and rejects its reuse", async () => {
    const valid = await credentialSignIn({ backupCode: backupCodes[0] });
    expect(valid.status).toBe(200);
    expect(await valid.json()).toMatchObject({ user: { id: userId } });

    const stored = await user();
    expect(JSON.parse(symmetricDecrypt(stored!.backupCodes!, encryptionKey))).toEqual([
      null,
      ...backupCodes.slice(1),
    ]);

    const reuse = await credentialSignIn({ backupCode: backupCodes[0] });
    expect(reuse.status).toBe(401);
    expect(await reuse.json()).toEqual({ code: "INCORRECT_BACKUP_CODE", message: "incorrect-backup-code" });
    expect(await sessions()).toMatchObject({
      results: [{ id: expect.any(String) }, { id: expect.any(String) }],
    });
  });
});
