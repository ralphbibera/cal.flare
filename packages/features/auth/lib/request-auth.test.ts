import { randomUUID } from "node:crypto";
import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { symmetricDecrypt, symmetricEncrypt } from "@calcom/lib/crypto";
import type { RuntimeStateNamespace } from "@calcom/lib/runtimeStateContext";
import { withRuntimeState } from "@calcom/lib/runtimeStateContext";
import prisma from "@calcom/prisma";
import { hash } from "bcryptjs";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { authenticator } from "otplib";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import type { authorizeCredentials } from "./authorizeCredentials";
import { authorizeCredentialsForRequest } from "./authorizeCredentials";
import { createCalRequestAuth } from "./request-auth";
import type { AuthRequestConfiguration } from "./request-context";
import { getAuthRequestConfiguration, withAuthRequestEnvironment } from "./request-context";

const origin = "https://calflare.test";
const password = "Synthetic-Password-123!";
const totpSecret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
const keys = ["1".repeat(32), "2".repeat(32)];
const runtimes: Miniflare[] = [];
const databases: Awaited<ReturnType<Miniflare["getD1Database"]>>[] = [];
let root: string;
let passwordHash: string;
let weakPasswordHash: string;
let limiter: RuntimeStateNamespace;
let brokenLimiter: RuntimeStateNamespace;

function config(index = 0, overrides: Partial<AuthRequestConfiguration> = {}): AuthRequestConfiguration {
  return {
    DB: databases[index],
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: `synthetic-signing-secret-${index}-${"x".repeat(32)}`,
    credentialPolicy: {
      encryptionKey: keys[index],
      isDevelopment: false,
      isE2E: false,
      rateLimit: "disabled",
    },
    ...overrides,
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-request-auth-"));
  const first = join(root, "first");
  const second = join(root, "second");
  await migrateD1({ persistTo: first });
  await cp(first, second, { recursive: true });
  const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
  for (const state of [first, second]) {
    const runtime = new Miniflare({
      cf: false,
      enableDevRegistry: false,
      telemetry: { enabled: false },
      resourcePersistencePath: join(state, "v3"),
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
                "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
              },
            },
          },
        },
      ],
    });
    runtimes.push(runtime);
    databases.push(await runtime.getD1Database("DB"));
  }
  const stdin = {
    contents: `export { RuntimeState } from "./RuntimeState";
      export class Broken { fetch() { throw new Error("runtime state unavailable"); } }
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
    workers: [worker.name, owner].map((name) => ({
      config: {
        name,
        compatibilityDate: worker.compatibilityDate,
        compatibilityFlags: worker.compatibilityFlags,
        ...(name === owner
          ? { exports: { RuntimeState: durableObject, Broken: durableObject } }
          : {
              env: {
                RUNTIME_STATE: worker.env.RUNTIME_STATE,
                BROKEN: { type: "durable-object", worker: owner, exportName: "Broken" },
              },
            }),
        manifest: {
          mainModule: "worker.js",
          modules: {
            "worker.js": {
              type: "esm" as const,
              contents:
                name === owner ? outputFiles[0].text : "export default {fetch(){return new Response()}}",
            },
          },
        },
      },
    })),
  });
  runtimes.push(runtime);
  const namespace = async (binding: string) =>
    (await runtime.getDurableObjectNamespace(binding, worker.name)) as unknown as RuntimeStateNamespace;
  [limiter, brokenLimiter] = await Promise.all([namespace("RUNTIME_STATE"), namespace("BROKEN")]);
  [passwordHash, weakPasswordHash] = await Promise.all([hash(password, 12), hash("weak", 12)]);
}, 120_000);

beforeEach(async () => {
  for (const [index, db] of databases.entries()) {
    await db.prepare('DELETE FROM "AuthUser"').run();
    await db.prepare("DELETE FROM users").run();
    await db
      .prepare("INSERT INTO users(id,uuid,email,username,name,metadata) VALUES(123,?,?,?,?,?)")
      .bind(`request-user-${index}`, "owner@calflare.test", "owner", `Owner ${index}`, '{"sessionTimeout":2}')
      .run();
    await db.prepare('INSERT INTO "UserPassword"(userId,hash) VALUES(123,?)').bind(passwordHash).run();
  }
});

afterEach(() => vi.unstubAllEnvs());

afterAll(async () => {
  for (const runtime of runtimes) await runtime.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

type Auth = ReturnType<typeof createCalRequestAuth>;
const credentials = (extra: Partial<NonNullable<Parameters<typeof authorizeCredentials>[0]>> = {}) => ({
  email: "owner@calflare.test",
  password,
  totpCode: "",
  backupCode: "",
  ...extra,
});
const authorize = (settings = config(), extra: Parameters<typeof credentials>[0] = {}) =>
  withAuthRequestEnvironment(settings, () =>
    authorizeCredentialsForRequest(credentials(extra), settings.credentialPolicy)
  );

function request(auth: Auth, path: string, cookie = "", body?: object) {
  return auth.handler(
    new Request(`${origin}/api/auth/${path}`, {
      method: body ? "POST" : "GET",
      headers: { cookie, ...(body ? { origin, "content-type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  );
}
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
const signIn = (auth: Auth, extra: Parameters<typeof credentials>[0] & { callbackUrl?: string } = {}) =>
  request(auth, "sign-in/cal-credentials", "", { ...credentials(), ...extra });
const sessionCookie = "__Secure-better-auth.session_token";
const rateLimited = /^Rate limit exceeded\. Try again in \d+ seconds\.$/;
const withLimiter = <T>(namespace: RuntimeStateNamespace | undefined, callback: () => T) =>
  withRuntimeState({ RUNTIME_STATE: namespace }, callback);
function enabledConfig() {
  const settings = config();
  return config(0, { credentialPolicy: { ...settings.credentialPolicy, rateLimit: "enabled" } });
}
// The core window outlives a test and is keyed by the hashed email, so each limiter test needs its own.
async function limitedEmail() {
  vi.stubEnv("UNKEY_ROOT_KEY", "configured");
  const email = `${randomUUID()}@calflare.test`;
  await databases[0].prepare("UPDATE users SET email=? WHERE id=123").bind(email).run();
  return email;
}
async function enableMfa(index = 0) {
  await databases[index]
    .prepare("UPDATE users SET twoFactorEnabled=1,twoFactorSecret=?,backupCodes=? WHERE id=123")
    .bind(symmetricEncrypt(totpSecret, keys[index]), symmetricEncrypt('["12345678","87654321"]', keys[index]))
    .run();
}

describe("request auth composition with real credential policy and migrated D1", () => {
  it("authorizes JSON credentials, signs a native session, and binds server reads and revocation", async () => {
    const auth = createCalRequestAuth(config());
    const response = await signIn(auth, { callbackUrl: "/bookings" });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      redirect: true,
      url: `${origin}/bookings`,
      user: { id: 123, name: "Owner 0", role: "USER" },
    });
    expect(cookies(response)).toMatch(new RegExp(`${sessionCookie}=.+`));
    const cookie = cookies(response);
    expect(await (await request(auth, "get-session", cookie)).json()).toMatchObject({
      hasValidLicense: false,
      user: { id: 123, name: "Owner 0", role: "USER" },
    });
    expect(await auth.api.getServerSession({ headers: new Headers({ cookie }) })).toMatchObject({
      user: { id: 123, uuid: "request-user-0" },
    });
    expect((await request(auth, "cal/update-session", cookie, { data: { upId: "usr-999" } })).status).toBe(
      403
    );
    const signedOut = await request(auth, "sign-out", cookie, {});
    expect(signedOut.status).toBe(200);
    expect(signedOut.headers.getSetCookie().some((value) => value.includes("Max-Age=0"))).toBe(true);
    expect((await databases[0].prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
    expect(await auth.api.getSessionClaims({ headers: new Headers({ cookie }) })).toBeNull();
    expect(await (await request(auth, "get-session", cookie)).json()).toBeNull();
  });

  it("returns Cal error codes with their statuses and issues no session", async () => {
    const auth = createCalRequestAuth(config());
    const rejected = async (extra: Parameters<typeof signIn>[1], status: number, message: string) => {
      const response = await signIn(auth, extra);
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({ message });
      expect(cookies(response)).not.toMatch(/session_token/);
    };
    await rejected({ password: "incorrect" }, 401, "incorrect-email-password");
    await rejected({ email: "missing@calflare.test" }, 401, "incorrect-email-password");
    await databases[0].prepare("UPDATE users SET locked=1 WHERE id=123").run();
    await rejected({}, 401, "incorrect-email-password");
    await databases[0].prepare("UPDATE users SET locked=0 WHERE id=123").run();
    await enableMfa();
    await rejected({}, 401, "second-factor-required");
    await rejected({ totpCode: "invalid" }, 401, "incorrect-two-factor-code");
    await rejected({ backupCode: "invalid" }, 401, "incorrect-backup-code");
    expect((await signIn(auth, { totpCode: authenticator.generate(totpSecret) })).status).toBe(200);
    const backup = await signIn(auth, { backupCode: "1234-5678" });
    expect(backup.status).toBe(200);
    await rejected({ backupCode: "12345678" }, 401, "incorrect-backup-code");
    expect((await databases[0].prepare('SELECT id FROM "AuthSession"').all()).results).toHaveLength(2);
  });

  it("rejects cross-site sign-in and sign-out before changing any session", async () => {
    const auth = createCalRequestAuth(config());
    const cookie = cookies(await signIn(auth));
    const sessions = async () => (await databases[0].prepare('SELECT id FROM "AuthSession"').all()).results;
    expect(await sessions()).toHaveLength(1);
    const post = (path: string, headers: Record<string, string>, body: object) =>
      auth.handler(
        new Request(`${origin}/api/auth/${path}`, {
          method: "POST",
          headers: { "content-type": "application/json", ...headers },
          body: JSON.stringify(body),
        })
      );
    const evil = { origin: "https://evil.test" };
    expect((await post("sign-out", { ...evil, cookie }, {})).status).toBe(403);
    expect((await post("sign-out", { cookie }, {})).status).toBe(403);
    expect((await post("sign-in/cal-credentials", { ...evil, cookie }, credentials())).status).toBe(403);
    expect((await post("sign-in/cal-credentials", evil, credentials())).status).toBe(403);
    const navigation = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
    expect((await post("sign-in/cal-credentials", navigation, credentials())).status).toBe(403);
    expect(await sessions()).toHaveLength(1);
    expect((await post("sign-out", { origin, cookie }, {})).status).toBe(200);
    expect(await sessions()).toEqual([]);
  });

  it.each([
    ["/bookings", `${origin}/bookings`],
    ["https://calflare.test:9443/bookings", "https://calflare.test:9443/bookings"],
    ["https://other.test/bookings", origin],
    ["ftp://calflare.test/bookings", origin],
    ["invalid URL", origin],
  ])("resolves the callback %s to %s", async (callbackUrl, expected) => {
    const response = await signIn(createCalRequestAuth(config()), { callbackUrl });
    expect(await response.json()).toMatchObject({ url: expected });
  });

  it("preserves lookup, limiter and password rejection order", async () => {
    const email = await limitedEmail();
    const enabled = enabledConfig();
    const attempt = (extra: Parameters<typeof credentials>[0] = {}) =>
      withLimiter(limiter, () => authorize(enabled, { email, ...extra }));
    await databases[0].prepare("UPDATE users SET locked=1 WHERE id=123").run();
    for (let i = 0; i < 11; i++) await expect(attempt()).rejects.toThrow("incorrect-email-password");
    await databases[0].prepare("UPDATE users SET locked=0 WHERE id=123").run();
    for (let i = 0; i < 10; i++) {
      await expect(attempt({ password: "incorrect" })).rejects.toThrow("incorrect-email-password");
    }
    await expect(attempt()).rejects.toThrow(rateLimited);
    await expect(attempt({ email: "missing@calflare.test" })).rejects.toThrow("incorrect-email-password");
    const settings = config();
    await enableMfa();
    await expect(authorize(settings, { password: "incorrect", backupCode: "incorrect" })).rejects.toThrow(
      "incorrect-email-password"
    );
    await databases[0].prepare('DELETE FROM "UserPassword" WHERE userId=123').run();
    await expect(authorize(settings)).rejects.toThrow("incorrect-email-password");
    expect((await databases[0].prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
  });

  it("retains encrypted TOTP and backup-code errors and consumes the matching backup code", async () => {
    await enableMfa();
    await expect(authorize()).rejects.toThrow("second-factor-required");
    await expect(authorize(config(), { totpCode: "invalid" })).rejects.toThrow("incorrect-two-factor-code");
    expect((await authorize(config(), { totpCode: authenticator.generate(totpSecret) })).id).toBe(123);
    await expect(authorize(config(), { backupCode: "invalid" })).rejects.toThrow("incorrect-backup-code");
    expect((await authorize(config(), { backupCode: "1234-5678", totpCode: "invalid" })).id).toBe(123);
    const stored = await databases[0]
      .prepare("SELECT backupCodes FROM users WHERE id=123")
      .first<{ backupCodes: string }>();
    expect(stored).not.toBeNull();
    expect(JSON.parse(symmetricDecrypt(stored!.backupCodes, keys[0]))).toEqual([null, "87654321"]);
    await expect(authorize(config(), { backupCode: "12345678" })).rejects.toThrow("incorrect-backup-code");
    await databases[0].prepare("UPDATE users SET backupCodes=NULL WHERE id=123").run();
    await expect(authorize(config(), { backupCode: "87654321" })).rejects.toThrow("missing-backup-codes");
    const settings = config();
    const missingKey = config(0, {
      credentialPolicy: { ...settings.credentialPolicy, encryptionKey: undefined },
    });
    await expect(authorize(missingKey, { backupCode: "87654321" })).rejects.toThrow("internal-server-error");
    await expect(authorize(missingKey, { totpCode: "123456" })).rejects.toThrow("internal-server-error");
    await databases[0]
      .prepare("UPDATE users SET twoFactorSecret=? WHERE id=123")
      .bind(symmetricEncrypt("short", keys[0]))
      .run();
    await expect(authorize(config(), { totpCode: "123456" })).rejects.toThrow("internal-server-error");
    await databases[0].prepare("UPDATE users SET twoFactorSecret=NULL WHERE id=123").run();
    await expect(authorize(config(), { totpCode: "123456" })).rejects.toThrow("internal-server-error");
  });

  it("admits enabled credential sign-ins up to the core limit, then rejects without a session", async () => {
    const email = await limitedEmail();
    const auth = createCalRequestAuth(enabledConfig());
    const attempt = () => withLimiter(limiter, () => signIn(auth, { email }));
    const sessions = async () =>
      (await databases[0].prepare('SELECT id FROM "AuthSession"').all()).results.length;
    for (let i = 0; i < 10; i++) expect((await attempt()).status).toBe(200);
    const issued = await sessions();
    expect(issued).toBeGreaterThan(0);
    const limited = await attempt();
    expect(limited.status).toBe(429);
    expect(await limited.json()).toMatchObject({ message: expect.stringMatching(rateLimited) });
    expect(cookies(limited)).not.toMatch(/session_token/);
    expect(await sessions()).toBe(issued);
  });

  it("leaves disabled limiting untouched even when the limiter is configured", async () => {
    vi.stubEnv("UNKEY_ROOT_KEY", "configured");
    const untouched = { idFromName: vi.fn(), get: vi.fn() };
    for (let i = 0; i < 11; i++) expect((await withLimiter(untouched, () => authorize())).id).toBe(123);
    expect(untouched.idFromName).not.toHaveBeenCalled();
  });

  it("fails open to password verification when the limiter errors or its binding is missing", async () => {
    const email = await limitedEmail();
    const enabled = enabledConfig();
    for (const namespace of [brokenLimiter, undefined]) {
      expect((await withLimiter(namespace, () => authorize(enabled, { email }))).id).toBe(123);
      await expect(
        withLimiter(namespace, () => authorize(enabled, { email, password: "incorrect" }))
      ).rejects.toThrow("incorrect-email-password");
    }
    const auth = createCalRequestAuth(enabled);
    const response = await withLimiter(brokenLimiter, () => signIn(auth, { email }));
    expect(response.status).toBe(200);
    expect(cookies(response)).toMatch(new RegExp(`${sessionCookie}=.+`));
  });

  it("preserves inactive-admin reasons and request-scoped development and E2E exceptions", async () => {
    await databases[0].prepare("UPDATE users SET role='ADMIN' WHERE id=123").run();
    expect(await authorize()).toMatchObject({ role: "INACTIVE_ADMIN", inactiveAdminReason: "2fa" });
    await databases[0]
      .prepare('UPDATE "UserPassword" SET hash=? WHERE userId=123')
      .bind(weakPasswordHash)
      .run();
    expect(await authorize(config(), { password: "weak" })).toMatchObject({
      role: "INACTIVE_ADMIN",
      inactiveAdminReason: "both",
    });
    await enableMfa();
    expect(
      await authorize(config(), { password: "weak", totpCode: authenticator.generate(totpSecret) })
    ).toMatchObject({ role: "INACTIVE_ADMIN", inactiveAdminReason: "password" });
    for (const exception of ["isDevelopment", "isE2E"]) {
      const settings = config();
      const exempt = config(0, { credentialPolicy: { ...settings.credentialPolicy, [exception]: true } });
      expect(
        (await authorize(exempt, { password: "weak", totpCode: authenticator.generate(totpSecret) })).role
      ).toBe("ADMIN");
    }
    await databases[0].prepare('UPDATE "UserPassword" SET hash=? WHERE userId=123').bind(passwordHash).run();
    expect((await authorize(config(), { totpCode: authenticator.generate(totpSecret) })).role).toBe("ADMIN");
    await databases[0]
      .prepare("UPDATE users SET identityProvider='GOOGLE',twoFactorEnabled=0 WHERE id=123")
      .run();
    expect((await authorize()).role).toBe("ADMIN");
  });

  it("isolates overlapping databases, MFA keys and signing secrets without leaking request context", async () => {
    await Promise.all([enableMfa(0), enableMfa(1)]);
    const settings = [config(0), config(1)];
    const auths = settings.map(createCalRequestAuth);
    const signedIn = await Promise.all(
      auths.map(async (auth) => {
        const response = await signIn(auth, { backupCode: "12345678" });
        expect(response.status).toBe(200);
        return cookies(response);
      })
    );
    for (const [index, auth] of auths.entries()) {
      expect(
        await auth.api.getServerSession({ headers: new Headers({ cookie: signedIn[index] }) })
      ).toMatchObject({ user: { name: `Owner ${index}` } });
      expect(
        await auth.api.getSessionClaims({ headers: new Headers({ cookie: signedIn[1 - index] }) })
      ).toBeNull();
    }
    const wrongSigner = createCalRequestAuth(config(0, { NEXTAUTH_SECRET: settings[1].NEXTAUTH_SECRET }));
    expect(
      await wrongSigner.api.getSessionClaims({ headers: new Headers({ cookie: signedIn[0] }) })
    ).toBeNull();
    expect(getAuthRequestConfiguration()).toBeUndefined();
    expect(() => prisma.user.findMany()).toThrow("D1 request binding is required");
  });

  it.each([
    "http://calflare.test",
    origin,
  ])("uses configured URL and %s cookie policy for the native session cookie", async (webappURL) => {
    const settings = config(0, { webappURL, NEXTAUTH_COOKIE_DOMAIN: ".calflare.test" });
    const response = await signIn(createCalRequestAuth(settings));
    expect(response.status).toBe(200);
    const prefix = webappURL.startsWith("https://") ? "__Secure-" : "";
    const cookie = response.headers
      .getSetCookie()
      .find((value) => value.startsWith(`${prefix}better-auth.session_token=`));
    expect(cookie).toContain("Domain=.calflare.test");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain(prefix ? "SameSite=None" : "SameSite=Lax");
    expect(cookie?.includes("; Secure")).toBe(Boolean(prefix));
  });
});
