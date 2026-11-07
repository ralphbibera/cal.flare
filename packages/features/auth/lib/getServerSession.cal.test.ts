import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prisma from "@calcom/prisma";
import { hash } from "bcryptjs";
import { Miniflare } from "miniflare";
import type { NextApiRequest } from "next";
import { encode } from "next-auth/jwt";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import { getLocale } from "./getLocale";
import { getServerSession } from "./getServerSession";
import { createCalRequestAuth } from "./request-auth";
import type { AuthRequestConfiguration } from "./request-context";
import { withAuthRequestEnvironment } from "./request-context";

const origin = "https://calflare.test";
const secret = `synthetic-dual-session-secret-${"x".repeat(32)}`;
const password = "Synthetic-Password-123!";
const email = "dual@calflare.test";
const profileId = 7;
const upId = "prof-owner-org";
const locale = "de";

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
  root = await mkdtemp(join(tmpdir(), "calflare-dual-session-"));
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
    db
      .prepare(
        `INSERT INTO users (id, uuid, email, username, name, emailVerified, locale, timeZone, completedOnboarding, role, metadata, avatarUrl)
         VALUES (123, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .bind(
        "dual-user",
        email,
        "dual",
        "Dual user",
        "2026-01-01T00:00:00.000Z",
        locale,
        "Europe/Paris",
        1,
        "USER",
        '{"sessionTimeout":2}',
        "https://cdn.calflare.test/avatar.png"
      ),
    db.prepare(`INSERT INTO "Team" (id, name, slug, isOrganization) VALUES (42, 'Org', 'org', 1)`),
    db
      .prepare(
        `INSERT INTO "Profile" (id, uid, userId, organizationId, username, updatedAt)
         VALUES (?, ?, 123, 42, ?, ?)`
      )
      .bind(profileId, "owner-org", "dual-org", "2026-01-01T00:00:00.000Z"),
    db.prepare('INSERT INTO "UserPassword" (userId, hash) VALUES (123, ?)').bind(passwordHash),
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

async function calCookie() {
  const auth = createCalRequestAuth(config());
  const csrfResponse = await auth.handler(new Request(`${origin}/api/auth/csrf`));
  expect(csrfResponse.status).toBe(200);
  const { csrfToken } = z.object({ csrfToken: z.string() }).parse(await csrfResponse.json());
  const response = await auth.handler(
    new Request(`${origin}/api/auth/callback/credentials`, {
      method: "POST",
      headers: {
        cookie: cookies(csrfResponse),
        origin,
        "content-type": "application/json",
      },
      body: JSON.stringify({ email, password, csrfToken, json: "true" }),
    })
  );
  expect(response.status).toBe(200);
  const session = response.headers
    .getSetCookie()
    .map((value) => value.split(";")[0])
    .find((value) => value.startsWith("__Secure-next-auth.session-token="));
  expect(session).toBeDefined();
  return session!;
}

async function jweCookie() {
  const token = await encode({
    token: {
      sub: "123",
      email,
      upId,
      profileId,
      belongsToActiveTeam: false,
      orgAwareUsername: "dual",
      locale,
    },
    secret,
    maxAge: 60 * 60,
  });
  return `__Secure-next-auth.session-token=${token}`;
}

function shape(value: unknown, path = ""): string[] {
  if (Array.isArray(value)) return value.flatMap((item, index) => shape(item, `${path}[${index}]`));
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, field]) => field !== undefined)
      .flatMap(([key, field]) => {
        const next = path ? `${path}.${key}` : key;
        return [next, ...shape(field, next)];
      });
  }
  return [];
}

describe("dual session cookie readers on migrated D1", () => {
  it("(a) reads a Cal credentials sign-in cookie through getServerSession", async () => {
    const cookie = await calCookie();
    const session = await read(() => getServerSession({ req: request(cookie) }));

    expect(session).toMatchObject({
      hasValidLicense: true,
      profileId,
      upId,
      user: {
        id: 123,
        email,
        username: "dual",
        name: "Dual user",
        locale,
        profile: { id: profileId, upId },
      },
    });
  });

  it("(b) keeps reading a next-auth JWE cookie exactly as before", async () => {
    const cookie = await jweCookie();
    const session = await read(() => getServerSession({ req: request(cookie) }));

    expect(session).toMatchObject({
      hasValidLicense: true,
      profileId,
      upId,
      user: {
        id: 123,
        email,
        username: "dual",
        name: "Dual user",
        locale,
        profile: { id: profileId, upId },
      },
    });
  });

  it("(c) projects the same shape and values for the same user from both formats", async () => {
    const cal = await calCookie();
    const jwe = await jweCookie();
    const calSession = await read(() => getServerSession({ req: request(cal) }));
    const jweSession = await read(() => getServerSession({ req: request(jwe) }));

    expect(calSession).not.toBeNull();
    expect(jweSession).not.toBeNull();
    expect(shape(calSession)).toEqual(shape(jweSession));

    const { expires: calExpires, ...calRest } = calSession!;
    const { expires: jweExpires, ...jweRest } = jweSession!;
    expect(typeof calExpires).toBe("string");
    expect(typeof jweExpires).toBe("string");
    expect(calRest).toEqual(jweRest);
  });

  it("(d) returns null for missing, garbage and tampered cookies", async () => {
    const validCal = await calCookie();
    const validJwe = await jweCookie();
    // The last character of a base64 segment can hold only padding bits, so flipping it may decode to
    // the same bytes; the one before it always carries six data bits.
    const tamper = (cookie: string) => {
      const index = cookie.lastIndexOf(".") - 2;
      const original = cookie[index];
      return `${cookie.slice(0, index)}${original === "A" ? "B" : "A"}${cookie.slice(index + 1)}`;
    };

    for (const cookie of [undefined, "garbage", "not.valid", tamper(validCal), tamper(validJwe)]) {
      await expect(read(() => getServerSession({ req: request(cookie) }))).resolves.toBeNull();
    }

    // Without a bound request environment the Cal reader has no D1 or signing secret.
    await expect(getServerSession({ req: request(validCal) })).resolves.toBeNull();
  });

  it("(e) reads the session locale from both formats", async () => {
    const cal = await calCookie();
    const jwe = await jweCookie();
    await expect(read(() => getLocale(request(cal)))).resolves.toBe(locale);
    await expect(read(() => getLocale(request(jwe)))).resolves.toBe(locale);
  });
});
