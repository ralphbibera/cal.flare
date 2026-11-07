import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import prisma from "@calcom/prisma";
import { hash } from "bcryptjs";
import { Miniflare } from "miniflare";
import type { NextApiRequest } from "next";
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

describe("Better Auth session readers on migrated D1", () => {
  it("reads a Cal credentials sign-in cookie through getServerSession", async () => {
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

  it("returns null for missing, garbage and tampered cookies", async () => {
    const validCal = await calCookie();
    // Tamper inside the signed/stored payload, not the last character: base64 padding bits can leave the last byte unchanged.
    const tamper = (cookie: string) => {
      const index = cookie.lastIndexOf(".") - 1;
      const original = cookie[index];
      return `${cookie.slice(0, index)}${original === "A" ? "B" : "A"}${cookie.slice(index + 1)}`;
    };

    for (const cookie of [undefined, "garbage", "not.valid", tamper(validCal)]) {
      await expect(read(() => getServerSession({ req: request(cookie) }))).resolves.toBeNull();
    }

    // Without a bound request environment the Cal reader has no D1 or signing secret.
    await expect(getServerSession({ req: request(validCal) })).resolves.toBeNull();
  });

  it("reads the session locale", async () => {
    const cookie = await calCookie();
    await expect(read(() => getLocale(request(cookie)))).resolves.toBe(locale);
  });
});
