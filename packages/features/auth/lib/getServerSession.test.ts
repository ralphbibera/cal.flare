import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hash } from "bcryptjs";
import { Miniflare } from "miniflare";
import type { NextApiRequest } from "next";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { getServerSession } from "./getServerSession";
import { createCalRequestAuth } from "./request-auth";
import type { AuthRequestConfiguration } from "./request-context";
import { withAuthRequestEnvironment } from "./request-context";

const origin = "https://calflare.test";
const secret = `synthetic-server-session-secret-${"x".repeat(32)}`;
const password = "Synthetic-Password-123!";
const sessionCookieName = "__Secure-better-auth.session_token";

const orgUser = { id: 123, email: "org-user@calflare.test", username: "orguser", name: "Org user" };
const plainUser = { id: 124, email: "plain-user@calflare.test", username: "plainuser", name: "Plain user" };
const avatarUrl = "https://cdn.calflare.test/avatar.png";
const profileId = 7;
const upId = "prof-owner-org";

let root: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
let passwordHash: string;

function config(): AuthRequestConfiguration {
  return {
    DB: db,
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: secret,
    credentialPolicy: {
      encryptionKey: "3".repeat(32),
      isDevelopment: false,
      isE2E: false,
      rateLimit: "disabled",
    },
  };
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-server-session-"));
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
              "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
            },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
  passwordHash = await hash(password, 12);
}, 120_000);

function insertUser(user: typeof orgUser) {
  return [
    db
      .prepare(
        `INSERT INTO users (id, uuid, email, username, name, emailVerified, locale, timeZone, completedOnboarding, role, metadata, avatarUrl)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        user.id,
        `uuid-${user.id}`,
        user.email,
        user.username,
        user.name,
        "2026-01-01T00:00:00.000Z",
        "en",
        "Europe/Paris",
        1,
        "USER",
        '{"sessionTimeout":2}',
        avatarUrl
      ),
    db.prepare('INSERT INTO "UserPassword" (userId, hash) VALUES (?, ?)').bind(user.id, passwordHash),
  ];
}

beforeEach(async () => {
  vi.stubEnv("NEXTAUTH_SECRET", secret);
  vi.stubEnv("NEXTAUTH_URL", origin);
  await db.batch([
    db.prepare('DELETE FROM "AuthSession"'),
    db.prepare('DELETE FROM "AuthUser"'),
    db.prepare('DELETE FROM "Profile"'),
    db.prepare('DELETE FROM "Team"'),
    db.prepare('DELETE FROM "UserPassword"'),
    db.prepare("DELETE FROM users"),
    ...insertUser(orgUser),
    ...insertUser(plainUser),
    db.prepare(`INSERT INTO "Team" (id, name, slug, isOrganization) VALUES (42, 'Org', 'org', 1)`),
    db
      .prepare(
        `INSERT INTO "Profile" (id, uid, userId, organizationId, username, updatedAt)
         VALUES (?, ?, ?, 42, ?, ?)`
      )
      .bind(profileId, "owner-org", orgUser.id, "dual-org", "2026-01-01T00:00:00.000Z"),
  ]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

afterAll(async () => {
  await mf?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

const read = <T>(callback: () => Promise<T>) => withAuthRequestEnvironment(config(), callback);

function cookies(response: Response) {
  return response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .join("; ");
}

function request(cookie?: string): NextApiRequest {
  const parsed: Record<string, string> = {};
  for (const part of cookie?.split("; ") ?? []) {
    const index = part.indexOf("=");
    parsed[part.slice(0, index)] = decodeURIComponent(part.slice(index + 1));
  }
  return {
    headers: new Headers(cookie ? { cookie } : {}),
    cookies: parsed,
  } as unknown as NextApiRequest;
}

const sessionFor = (cookie?: string) => read(() => getServerSession({ req: request(cookie) }));

async function signIn(email: string) {
  const response = await createCalRequestAuth(config()).handler(
    new Request(`${origin}/api/auth/sign-in/cal-credentials`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ email, password }),
    })
  );
  expect(response.status).toBe(200);
  const session = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith(`${sessionCookieName}=`));
  expect(session).toBeDefined();
  return { cookie: session as string };
}

async function signOut(state: Awaited<ReturnType<typeof signIn>>) {
  const response = await createCalRequestAuth(config()).handler(
    new Request(`${origin}/api/auth/sign-out`, {
      method: "POST",
      headers: { cookie: state.cookie, origin, "content-type": "application/json" },
      body: JSON.stringify({}),
    })
  );
  expect(response.status).toBe(200);
}

// Tamper inside the signed payload, not the last character: base64 padding bits can leave the last byte unchanged.
function tamper(cookie: string) {
  const index = cookie.lastIndexOf(".") - 1;
  const original = cookie[index];
  return `${cookie.slice(0, index)}${original === "A" ? "B" : "A"}${cookie.slice(index + 1)}`;
}

describe("getServerSession", () => {
  describe("Token Validation", () => {
    it("returns null when there is no session cookie", async () => {
      await expect(sessionFor(undefined)).resolves.toBeNull();
    });

    it("returns null for a garbage session cookie", async () => {
      await expect(sessionFor(`${sessionCookieName}=garbage`)).resolves.toBeNull();
      await expect(sessionFor("garbage")).resolves.toBeNull();
    });

    it("returns null for a tampered signed session cookie", async () => {
      const { cookie } = await signIn(orgUser.email);
      await expect(sessionFor(cookie)).resolves.not.toBeNull();
      await expect(sessionFor(tamper(cookie))).resolves.toBeNull();
    });

    it("returns null for a revoked (signed-out) session", async () => {
      const state = await signIn(orgUser.email);
      await expect(sessionFor(state.cookie)).resolves.not.toBeNull();

      await signOut(state);

      expect((await db.prepare('SELECT id FROM "AuthSession"').all()).results).toEqual([]);
      await expect(sessionFor(state.cookie)).resolves.toBeNull();
    });
  });

  describe("User ID Validation", () => {
    it("cannot map a session to a Cal user id with no users row", async () => {
      const { cookie } = await signIn(orgUser.email);
      const danglingId = 9999;

      // The AuthUser foreign key makes a dangling mapping unrepresentable, so the reader's null-on-missing-user guard is exercised by the deletion case below.
      await expect(
        db.prepare('UPDATE "AuthUser" SET calUserId=? WHERE calUserId=?').bind(danglingId, orgUser.id).run()
      ).rejects.toThrow(/FOREIGN KEY/);

      await expect(sessionFor(cookie)).resolves.toMatchObject({ user: { id: orgUser.id } });
    });

    it("returns null for a session whose user was later deleted from users", async () => {
      const { cookie } = await signIn(orgUser.email);
      await expect(sessionFor(cookie)).resolves.not.toBeNull();

      await db.prepare("DELETE FROM users WHERE id=?").bind(orgUser.id).run();

      await expect(sessionFor(cookie)).resolves.toBeNull();
    });
  });

  describe("User Lookup", () => {
    it("resolves the user through the session's Cal user id", async () => {
      const { cookie } = await signIn(plainUser.email);

      const mirror = await db
        .prepare('SELECT calUserId FROM "AuthUser" WHERE email=?')
        .bind(plainUser.email)
        .first<{ calUserId: number }>();
      expect(mirror?.calUserId).toBe(plainUser.id);

      await expect(sessionFor(cookie)).resolves.toMatchObject({
        user: { id: plainUser.id, email: plainUser.email },
      });
    });

    it("returns null when the user row is missing", async () => {
      const { cookie } = await signIn(plainUser.email);
      await db.prepare("DELETE FROM users WHERE id=?").bind(plainUser.id).run();

      await expect(sessionFor(cookie)).resolves.toBeNull();
    });

    it("returns session with correct user data", async () => {
      const { cookie } = await signIn(plainUser.email);

      const session = await sessionFor(cookie);

      expect(session).toMatchObject({
        hasValidLicense: true,
        upId: `usr-${plainUser.id}`,
        user: {
          id: plainUser.id,
          uuid: `uuid-${plainUser.id}`,
          email: plainUser.email,
          name: plainUser.name,
          username: plainUser.username,
          role: "USER",
          locale: "en",
          completedOnboarding: true,
          email_verified: true,
          image: avatarUrl,
        },
      });
      expect(session?.user.profile).toMatchObject({
        id: null,
        upId: `usr-${plainUser.id}`,
        organization: null,
      });
    });

    it("includes the profile and organization where applicable", async () => {
      const { cookie } = await signIn(orgUser.email);

      await expect(sessionFor(cookie)).resolves.toMatchObject({
        profileId,
        upId,
        user: {
          id: orgUser.id,
          email: orgUser.email,
          profile: { id: profileId, upId },
        },
      });
    });
  });

  describe("User Resolution", () => {
    it("reads user data from the database, not the cookie", async () => {
      const { cookie } = await signIn(plainUser.email);
      await expect(sessionFor(cookie)).resolves.toMatchObject({ user: { name: plainUser.name } });

      await db.prepare("UPDATE users SET name=? WHERE id=?").bind("Renamed user", plainUser.id).run();

      await expect(sessionFor(cookie)).resolves.toMatchObject({
        user: { id: plainUser.id, name: "Renamed user" },
      });
    });

    it("keeps each session bound to its own user", async () => {
      const [org, plain] = [await signIn(orgUser.email), await signIn(plainUser.email)];

      await expect(sessionFor(org.cookie)).resolves.toMatchObject({ user: { id: orgUser.id } });
      await expect(sessionFor(plain.cookie)).resolves.toMatchObject({ user: { id: plainUser.id } });
    });
  });
});
