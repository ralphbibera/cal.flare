import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { migrateD1 } from "../../../prisma/migrate-d1.mjs";
import type { AuthRequestConfiguration } from "./request-context";
import { withAuthRequestEnvironment } from "./request-context";

const origin = "https://calflare.test";
const links: string[] = [];

vi.mock("@calcom/emails/auth-email-service", () => ({
  sendEmailVerificationLink: async ({ verificationEmailLink }: { verificationEmailLink: string }) => {
    links.push(verificationEmailLink);
  },
  sendChangeOfEmailVerificationLink: vi.fn(),
  sendEmailVerificationCode: vi.fn(),
}));
vi.mock("@calcom/lib/checkRateLimitAndThrowError", () => ({ checkRateLimitAndThrowError: async () => {} }));
vi.mock("@calcom/features/watchlist/operations/check-if-email-in-watchlist.controller", () => ({
  checkIfEmailIsBlockedInWatchlistController: async () => false,
}));

let root: string;
let runtime: Miniflare;
let config: AuthRequestConfiguration;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-verify-email-"));
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
  config = {
    DB: await runtime.getD1Database("DB"),
    baseURL: origin,
    webappURL: origin,
    NEXTAUTH_SECRET: `synthetic-signing-secret-${"x".repeat(32)}`,
  };
}, 120_000);

beforeEach(async () => {
  links.length = 0;
  await config.DB.prepare('DELETE FROM "VerificationToken"').run();
  await config.DB.prepare("DELETE FROM users").run();
  await config.DB.prepare("INSERT INTO users(id,uuid,email,username,name) VALUES(7,?,?,?,?)")
    .bind("verify-user", "pending@calflare.test", "pending", "Pending")
    .run();
});

afterAll(async () => {
  await runtime?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

function consume(token: string) {
  const response: { status?: number; body?: unknown; location?: string } = {};
  const res = {
    status(code: number) {
      response.status = code;
      return res;
    },
    json(body: unknown) {
      response.body = body;
      return res;
    },
    redirect(location: string) {
      response.location = location;
      return res;
    },
  };
  return withAuthRequestEnvironment(config, async () => {
    const { handler } = await import("../../../../apps/web/lib/pages/auth/verify-email");
    await handler({ query: { token } } as never, res as never);
    return response;
  });
}

const request = () =>
  withAuthRequestEnvironment(config, async () => {
    const { sendEmailVerification } = await import("./verifyEmail");
    return sendEmailVerification({ email: "pending@calflare.test", username: "pending" });
  });
const emailVerified = async () =>
  (
    await config.DB.prepare("SELECT emailVerified FROM users WHERE id=7").first<{
      emailVerified: string | null;
    }>()
  )?.emailVerified;

describe("email verification on migrated D1", () => {
  it("stores a one-day token, emails the verify link, and consuming it sets emailVerified once", async () => {
    expect(await request()).toEqual({ ok: true, skipped: false });
    expect(links).toHaveLength(1);
    const link = new URL(links[0]);
    expect(link.pathname).toBe("/api/auth/verify-email");
    const token = link.searchParams.get("token") ?? "";
    const stored = await config.DB.prepare('SELECT identifier,expires FROM "VerificationToken"').first<{
      identifier: string;
      expires: string;
    }>();
    expect(stored?.identifier).toBe("pending@calflare.test");
    const hours = (new Date(stored?.expires ?? 0).getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(await emailVerified()).toBeNull();

    const consumed = await consume(token);
    expect(consumed.location).toMatch(/\/(event-types|getting-started.*)$/);
    expect(await emailVerified()).not.toBeNull();
  });

  it("rejects unknown and expired tokens with the source errors and leaves emailVerified unset", async () => {
    await request();
    const token = new URL(links[0]).searchParams.get("token") ?? "";
    expect(await consume("missing")).toMatchObject({ status: 401, body: { message: "No token found" } });
    await config.DB.prepare('UPDATE "VerificationToken" SET expires=?')
      .bind("2000-01-01T00:00:00.000Z")
      .run();
    expect(await consume(token)).toMatchObject({ status: 401, body: { message: "Token expired" } });
    expect(await emailVerified()).toBeNull();
  });
});
