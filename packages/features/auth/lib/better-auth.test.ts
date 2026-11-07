import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { z } from "zod";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";

let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const fixture = new URL("./__tests__/fixtures/", import.meta.url);
const migration = new URL("../../../prisma/migrations-d1/0004_auth.sql", import.meta.url);

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-auth-test-"));
  const persistTo = join(root, "state");
  expect(await migrateD1({ persistTo })).toMatchObject({ applied: 6, total: 6 });
  const bundled = await build({
    entryPoints: [fileURLToPath(new URL("better-auth.worker.ts", fixture))],
    bundle: true,
    write: false,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    conditions: ["workerd", "worker", "browser"],
    external: ["node:*"],
  });
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
          env: { DB: worker.env.DB, SCHEMA: { type: "d1", name: "auth-schema", dev: { remote: false } } },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: bundled.outputFiles[0].text },
            },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
  await db
    .prepare("INSERT INTO users (id,uuid,email) VALUES (123,'synthetic-auth-user','library@calflare.test')")
    .run();
}, 120_000);

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});
beforeEach(async () => {
  await db.prepare('DELETE FROM "AuthUser"').run();
  await db.prepare('DELETE FROM "AuthVerification"').run();
});

async function issue(origin = "https://calflare.test") {
  const response = await mf.dispatchFetch(`${origin}/api/auth/fixture-session`, {
    method: "POST",
    headers: { origin, "content-type": "application/json" },
    body: "{}",
  });
  expect(response.status).toBe(200);
  const setCookie = response.headers.get("set-cookie") ?? "";
  return { setCookie, cookie: setCookie.split(";")[0] };
}
const lookup = (cookie: string) =>
  mf.dispatchFetch("https://calflare.test/api/auth/get-session", { headers: { cookie } });

describe("Better Auth native D1 foundation (library-only)", () => {
  const cal = (action: string, cookie = "", sessionTimeout?: number) =>
    mf.dispatchFetch(`https://calflare.test/api/auth/fixture-cal/${action}`, {
      method: action === "read" ? "GET" : "POST",
      headers: { cookie, origin: "https://calflare.test", "content-type": "application/json" },
      ...(action === "read" ? {} : { body: JSON.stringify({ sessionTimeout }) }),
    });

  it("issues a Cal snapshot with effective validity separate from browser expiry", async () => {
    const issued = await cal("issue", "", 2);
    expect(issued.status).toBe(200);
    const cookie = (issued.headers.get("set-cookie") ?? "").split(";")[0];
    expect(cookie).toMatch(/^__Secure-next-auth.session-token=/);
    expect(issued.headers.get("set-cookie")).toContain("Max-Age=2592000");
    const response = await cal("read", cookie);
    const session = z
      .object({
        expiresAt: z.string(),
        browser: z.object({ expires: z.string() }).passthrough(),
      })
      .passthrough()
      .parse(await response.json());
    expect(session).toMatchObject({
      browser: {
        hasValidLicense: false,
        profileId: null,
        upId: "usr-123",
        user: { id: 123, role: "INACTIVE_ADMIN", inactiveAdminReason: "both", locale: "de" },
      },
    });
    expect(new Date(session.expiresAt).getTime() - Date.now()).toBeGreaterThan(110_000);
    expect(new Date(session.expiresAt).getTime() - Date.now()).toBeLessThanOrEqual(120_000);
    expect(new Date(session.browser.expires).getTime() - Date.now()).toBeGreaterThan(29 * 86400_000);
    expect(JSON.stringify(session)).not.toMatch(/calUserId|userId|token|password|twoFactorSecret/);
    expect(response.headers.get("set-cookie")).toBeNull();
  });

  it("keeps lookup read-only and explicitly renews, updates, expires and revokes sessions", async () => {
    const issued = await cal("issue", "", 2);
    const cookie = (issued.headers.get("set-cookie") ?? "").split(";")[0];
    const before = (await db.prepare('SELECT * FROM "AuthSession"').all()).results;
    await cal("read", cookie);
    expect((await db.prepare('SELECT * FROM "AuthSession"').all()).results).toEqual(before);
    const renewed = await cal("renew", cookie);
    expect(renewed.headers.get("set-cookie")).toContain("Max-Age=2592000");
    expect(await renewed.json()).toMatchObject({ user: { id: 123, locale: "ar", role: "INACTIVE_ADMIN" } });
    const validity = await db.prepare('SELECT expiresAt FROM "AuthSession"').first<{ expiresAt: string }>();
    expect(new Date(validity!.expiresAt).getTime() - Date.now()).toBeGreaterThan(290_000);
    await db.prepare('UPDATE "AuthSession" SET expiresAt=?').bind("2020-01-01T00:00:00.000Z").run();
    expect(await (await cal("read", cookie)).json()).toBeNull();
    expect(await (await cal("renew", cookie)).json()).toBeNull();
    const signedIn = await cal("issue");
    const nextCookie = (signedIn.headers.get("set-cookie") ?? "").split(";")[0];
    const signedOut = await cal("revoke", nextCookie);
    expect(signedOut.headers.get("set-cookie")).toContain("Max-Age=0");
    expect(await (await cal("read", nextCookie)).json()).toBeNull();
  });

  it("uses one opaque mapping across logins and prevents locked or missing Cal users from acquiring sessions", async () => {
    expect((await cal("issue")).status).toBe(200);
    const first = (await db.prepare('SELECT id,calUserId FROM "AuthUser"').all()).results;
    expect((await cal("issue")).status).toBe(200);
    expect((await db.prepare('SELECT id,calUserId FROM "AuthUser"').all()).results).toEqual(first);
    await db.prepare("UPDATE users SET locked=1 WHERE id=123").run();
    const count = (await db.prepare('SELECT id FROM "AuthSession"').all()).results.length;
    expect((await cal("issue")).status).toBe(500);
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toHaveLength(count);
    await db.prepare("UPDATE users SET locked=0 WHERE id=123").run();
    await db.prepare("DELETE FROM users WHERE id=123").run();
    expect((await cal("issue")).status).toBe(500);
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
    await db
      .prepare("INSERT INTO users (id,uuid,email) VALUES (123,'synthetic-auth-user','library@calflare.test')")
      .run();
  });

  it("reproduces exact SDK schema with only the reviewed numeric domain FK", async () => {
    const response = await mf.dispatchFetch("https://calflare.test/schema");
    expect(response.status).toBe(200);
    const generated = await response.text();
    expect(generated).toBe(await readFile(new URL("better-auth.generated.sql", fixture), "utf8"));
    const reviewed = (await readFile(migration, "utf8")).replace(/^--.*\n/gm, "").trimEnd();
    expect(reviewed).toBe(
      generated
        .replace(
          '"calUserId" integer not null unique',
          '"calUserId" integer not null unique references "users" ("id") on delete cascade'
        )
        .trimEnd()
    );
    expect((await db.prepare('PRAGMA foreign_key_list("AuthUser")').all()).results).toMatchObject([
      { table: "users", from: "calUserId", to: "id", on_delete: "CASCADE" },
    ]);
  });

  it("round-trips numeric identity and JSON snapshots through actual signed session storage", async () => {
    const { cookie } = await issue();
    expect(await (await lookup(cookie)).json()).toMatchObject({
      user: { calUserId: 123 },
      session: {
        calClaims: { id: 123, role: "USER", hasValidLicense: false },
        profileContext: { profileId: 7, upId: "123" },
      },
    });
    expect((await db.prepare('SELECT typeof(calUserId) AS kind FROM "AuthUser"').all()).results).toEqual([
      { kind: "integer" },
    ]);
    const dates = (await db.prepare('SELECT typeof(createdAt) AS kind, createdAt FROM "AuthSession"').all())
      .results;
    expect(dates).toMatchObject([{ kind: "text", createdAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/) }]);
    expect((await db.prepare('SELECT providerId,accountId FROM "AuthAccount"').all()).results).toEqual([
      { providerId: "library-fixture", accountId: "synthetic-subject" },
    ]);
    expect((await db.prepare('SELECT identifier,value FROM "AuthVerification"').all()).results).toEqual([
      { identifier: "synthetic-verification", value: "synthetic-value" },
    ]);
    expect(await (await lookup(`${cookie}tampered`)).json()).toBeNull();
  });

  it("rejects missing, duplicate, and orphan domain identities and cascades domain deletion", async () => {
    await issue();
    const copy = (id: string, identity: string) =>
      db
        .prepare(
          `INSERT INTO "AuthUser" SELECT ?,name,? ,emailVerified,image,createdAt,updatedAt,${identity} FROM "AuthUser" LIMIT 1`
        )
        .bind(id, `${id}@calflare.test`)
        .run();
    await expect(copy("orphan", "999999")).rejects.toThrow(/FOREIGN KEY/);
    await expect(copy("duplicate", "123")).rejects.toThrow(/UNIQUE/);
    await expect(copy("missing", "NULL")).rejects.toThrow(/NOT NULL/);
    await db.prepare("DELETE FROM users WHERE id=123").run();
    expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
    expect((await db.prepare('SELECT id FROM "AuthAccount"').all()).results).toEqual([]);
    expect((await db.prepare('SELECT id FROM "AuthUser"').all()).results).toEqual([]);
    await db
      .prepare("INSERT INTO users (id,uuid,email) VALUES (123,'synthetic-auth-user','library@calflare.test')")
      .run();
  });

  it("uses the original HTTPS and dev cookie policy with thirty-day browser lifetime", async () => {
    const { setCookie } = await issue();
    for (const attribute of [
      "__Secure-next-auth.session-token=",
      "Max-Age=2592000",
      "Domain=.calflare.test",
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=None",
    ])
      expect(setCookie).toContain(attribute);
    expect(setCookie).not.toContain("session_data");
    const lifetime = await db
      .prepare('SELECT (julianday(expiresAt)-julianday(createdAt))*86400 AS seconds FROM "AuthSession"')
      .first<{ seconds: number }>();
    expect(lifetime?.seconds).toBeCloseTo(30 * 24 * 60 * 60, 0);
    await db.prepare('DELETE FROM "AuthUser"').run();
    const dev = (await issue("http://localhost")).setCookie;
    for (const attribute of [
      "next-auth.session-token=",
      "Max-Age=2592000",
      "Path=/",
      "HttpOnly",
      "SameSite=Lax",
    ])
      expect(dev).toContain(attribute);
    expect(dev).not.toMatch(/__Secure-|; Secure|Domain=/);
  });

  it("reads D1 on every lookup, observes revocation and expiry, and never refreshes", async () => {
    const { cookie } = await issue();
    await db
      .prepare('UPDATE "AuthSession" SET createdAt=?,updatedAt=?,expiresAt=?')
      .bind(
        "2020-01-01T00:00:00.000Z",
        "2020-01-01T00:00:00.000Z",
        new Date(Date.now() + 60_000).toISOString()
      )
      .run();
    const before = (await db.prepare('SELECT * FROM "AuthSession"').all()).results;
    const first = await lookup(cookie);
    expect(await first.json()).toMatchObject({ user: { calUserId: 123 } });
    expect(first.headers.get("set-cookie")).toBeNull();
    expect((await db.prepare('SELECT * FROM "AuthSession"').all()).results).toEqual(before);
    await db.prepare('DELETE FROM "AuthSession"').run();
    expect(await (await lookup(cookie)).json()).toBeNull();
    await db.prepare('DELETE FROM "AuthUser"').run();
    const expiring = await issue();
    await db.prepare('UPDATE "AuthSession" SET expiresAt=?').bind("2020-01-01T00:00:00.000Z").run();
    expect(await (await lookup(expiring.cookie)).json()).toBeNull();
  });

  it("disables stock password/signup routes while retaining origin checks", async () => {
    for (const path of [
      "sign-up/email",
      "sign-in/email",
      "sign-in/social",
      "link-social",
      "two-factor/enable",
    ]) {
      const response = await mf.dispatchFetch(`https://calflare.test/api/auth/${path}`, {
        method: "POST",
        headers: { origin: "https://calflare.test", "content-type": "application/json" },
        body: JSON.stringify({ email: "attacker@calflare.test", password: "not-a-Cal-login" }),
      });
      expect(response.status, path).toBe(404);
    }
    expect((await db.prepare('SELECT id FROM "AuthUser"').all()).results).toEqual([]);
    const { cookie } = await issue();
    const crossOrigin = await mf.dispatchFetch("https://calflare.test/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "https://untrusted.test", cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(crossOrigin.status).toBe(403);
    expect(await (await lookup(cookie)).json()).toMatchObject({ user: { calUserId: 123 } });
    const signOut = await mf.dispatchFetch("https://calflare.test/api/auth/sign-out", {
      method: "POST",
      headers: { origin: "https://calflare.test", cookie, "content-type": "application/json" },
      body: "{}",
    });
    expect(signOut.status).toBe(200);
    expect(await (await lookup(cookie)).json()).toBeNull();
    expect(await (await mf.dispatchFetch("https://calflare.test/missing-secret")).text()).toBe("rejected");
  });
});
