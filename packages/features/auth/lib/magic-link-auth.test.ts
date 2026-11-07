import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { createCalRequestAuth } from "./request-auth";
import type { AuthRequestConfiguration } from "./request-context";

const origin = "https://calflare.test";
const sessionCookie = "__Secure-better-auth.session_token";
let root: string;
let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const sent: { identifier: string; url: string }[] = [];

function auth() {
  const config: AuthRequestConfiguration = {
    DB: db,
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: `synthetic-signing-secret-${"x".repeat(32)}`,
    sendMagicLinkEmail: async (params) => {
      sent.push(params);
    },
  };
  return createCalRequestAuth(config);
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-magic-link-"));
  await migrateD1({ persistTo: root });
  const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
  runtime = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(root, "v3"),
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
  db = await runtime.getD1Database("DB");
}, 120_000);

beforeEach(async () => {
  sent.length = 0;
  for (const table of ["AuthSession", "AuthVerification", "AuthUser"]) {
    await db.prepare(`DELETE FROM "${table}"`).run();
  }
  await db.prepare("DELETE FROM users").run();
  await db
    .prepare("INSERT INTO users(id,uuid,email,username,name) VALUES(123,?,?,?,?)")
    .bind("magic-user", "owner@calflare.test", "owner", "Owner")
    .run();
});

afterAll(async () => {
  await runtime?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

type Auth = ReturnType<typeof createCalRequestAuth>;
const requestLink = (a: Auth, body: object, headers: Record<string, string> = { origin }) =>
  a.handler(
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(body),
    })
  );
const follow = (a: Auth, url: string) => a.handler(new Request(url, { headers: { cookie: "" } }));
const cookies = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
const rows = async (table: string) => (await db.prepare(`SELECT * FROM "${table}"`).all()).results;

describe("native Better Auth magic link on migrated D1", () => {
  it("stores one token, sends one email, and the link creates a session and redirects to the callback", async () => {
    const a = auth();
    const requested = await requestLink(a, { email: "owner@calflare.test", callbackURL: "/bookings" });
    expect(requested.status).toBe(200);
    expect(await requested.json()).toEqual({ status: true });
    expect(sent).toHaveLength(1);
    expect(sent[0].identifier).toBe("owner@calflare.test");
    const link = new URL(sent[0].url);
    expect(link.origin + link.pathname).toBe(`${origin}/api/auth/cal/magic-link/verify`);
    expect(link.searchParams.get("callbackURL")).toBe("/bookings");

    const [stored] = await rows("AuthVerification");
    expect(await rows("AuthVerification")).toHaveLength(1);
    expect(stored).toMatchObject({ identifier: `magic-link:${link.searchParams.get("token")}` });
    const hours = (new Date(String(stored.expiresAt)).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(9.9);
    expect(hours).toBeLessThanOrEqual(10);

    const verified = await follow(a, sent[0].url);
    expect(verified.status).toBe(302);
    expect(verified.headers.get("location")).toBe(`${origin}/bookings`);
    const cookie = cookies(verified);
    expect(cookie).toMatch(new RegExp(`${sessionCookie}=.+`));
    expect(cookie).not.toMatch(/next-auth/);
    expect(await rows("AuthVerification")).toEqual([]);
    const session = await a.handler(new Request(`${origin}/api/auth/get-session`, { headers: { cookie } }));
    expect(await session.json()).toMatchObject({ user: { id: 123, username: "owner" } });
  });

  it("marks an unverified user verified when the link is followed", async () => {
    const a = auth();
    await requestLink(a, { email: "owner@calflare.test" });
    const verified = await follow(a, sent[0].url);
    expect(verified.headers.get("location")).toBe(`${origin}/`);
    const user = await db.prepare("SELECT emailVerified FROM users WHERE id=123").first<{
      emailVerified: string | null;
    }>();
    expect(user?.emailVerified).not.toBeNull();
  });

  it("rejects a reused link with the source Verification error and issues no second session", async () => {
    const a = auth();
    await requestLink(a, { email: "owner@calflare.test" });
    expect((await follow(a, sent[0].url)).headers.get("location")).toBe(`${origin}/`);
    const replay = await follow(a, sent[0].url);
    expect(replay.status).toBe(302);
    expect(replay.headers.get("location")).toBe(`${origin}/auth/error?error=Verification`);
    expect(cookies(replay)).not.toMatch(/session_token/);
    expect(await rows("AuthSession")).toHaveLength(1);
  });

  it("rejects an expired link and an unknown token", async () => {
    const a = auth();
    await requestLink(a, { email: "owner@calflare.test" });
    await db.prepare('UPDATE "AuthVerification" SET expiresAt=?').bind("2000-01-01T00:00:00.000Z").run();
    const expired = await follow(a, sent[0].url);
    expect(expired.headers.get("location")).toBe(`${origin}/auth/error?error=Verification`);
    expect(cookies(expired)).not.toMatch(/session_token/);
    const unknown = await follow(a, `${origin}/api/auth/cal/magic-link/verify?token=missing`);
    expect(unknown.headers.get("location")).toBe(`${origin}/auth/error?error=Verification`);
    expect(await rows("AuthSession")).toEqual([]);
  });

  it("creates the user for an unknown email, as the source email provider did", async () => {
    const a = auth();
    await requestLink(a, { email: "New.Person@calflare.test" });
    expect(sent).toHaveLength(1);
    const verified = await follow(a, sent[0].url);
    expect(verified.headers.get("location")).toBe(`${origin}/`);
    expect(cookies(verified)).toMatch(new RegExp(`${sessionCookie}=.+`));
    const created = await db
      .prepare("SELECT username,name,emailVerified FROM users WHERE email=?")
      .bind("new.person@calflare.test")
      .first<{ username: string | null; name: string | null; emailVerified: string | null }>();
    expect(created).toMatchObject({ username: null, name: null });
    expect(created?.emailVerified).not.toBeNull();
  });

  it("falls back to the base URL for a tampered callback outside the webapp host", async () => {
    const a = auth();
    await requestLink(a, { email: "owner@calflare.test" });
    const link = new URL(sent[0].url);
    link.searchParams.set("callbackURL", "https://evil.test/steal");
    const verified = await follow(a, link.toString());
    expect(verified.headers.get("location")).toBe(origin);
  });

  it("does not serve the native verify endpoint, whose session would carry no Cal claims", async () => {
    const a = auth();
    await requestLink(a, { email: "owner@calflare.test" });
    const token = new URL(sent[0].url).searchParams.get("token");
    const native = await follow(a, `${origin}/api/auth/magic-link/verify?token=${token}`);
    expect(native.status).toBe(404);
    expect(cookies(native)).not.toMatch(/session_token/);
    expect(await rows("AuthVerification")).toHaveLength(1);
  });

  it("rejects cross-site requests before storing a token or sending an email", async () => {
    const a = auth();
    const body = { email: "owner@calflare.test" };
    const navigation = { "sec-fetch-site": "cross-site", "sec-fetch-mode": "navigate" };
    const statuses = [];
    for (const headers of [{ origin: "https://evil.test" }, navigation]) {
      statuses.push((await requestLink(a, body, headers)).status);
    }
    expect(statuses).toEqual([403, 403]);
    expect(sent).toEqual([]);
    expect(await rows("AuthVerification")).toEqual([]);
  });

  it("sends the existing confirm-email template with the Cal verify link", async () => {
    const sendMail = vi.fn();
    vi.resetModules();
    vi.doMock("nodemailer", () => ({
      default: { createTransport: () => ({ sendMail }) },
    }));
    vi.spyOn(process, "cwd").mockReturnValue(join(__dirname, "../../../../apps/web"));
    const { default: sendVerificationRequest } = await import("./sendVerificationRequest");
    await sendVerificationRequest({
      identifier: "owner@calflare.test",
      url: "http://other.test/api/auth/cal/magic-link/verify?token=abc",
    });
    expect(sendMail).toHaveBeenCalledOnce();
    const message = sendMail.mock.calls[0][0];
    expect(message.to).toBe("owner@calflare.test");
    expect(message.subject).toMatch(/^Your sign-in link for /);
    expect(message.html).toContain("/api/auth/cal/magic-link/verify?token&#x3D;abc");
    expect(message.html).not.toContain("other.test");
    vi.doUnmock("nodemailer");
    vi.restoreAllMocks();
  });
});
