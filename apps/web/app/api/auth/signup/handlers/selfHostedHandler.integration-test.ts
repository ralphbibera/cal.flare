import { cp, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import process from "node:process";
import { SIGNUP_ERROR_CODES } from "@calcom/features/auth/signup/constants";
import { withD1Database } from "@calcom/prisma/d1";
import { compare } from "bcryptjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import handler from "./selfHostedHandler";

const mail = vi.hoisted(() => ({ sendEmailVerification: vi.fn() }));
vi.mock("@calcom/features/auth/lib/verifyEmail", () => ({
  sendEmailVerification: mail.sendEmailVerification,
}));

const password = "Synthetic-Password-123!";
const future = "2099-01-01T00:00:00.000Z";

let root: string;
let runtime: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;

const signup = (body: Record<string, string>) => withD1Database({ DB: db }, () => handler(body));

const userRows = async () =>
  (
    await db
      .prepare("SELECT id,email,username,emailVerified,identityProvider,invitedTo FROM users ORDER BY id")
      .all()
  ).results;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "calflare-self-hosted-signup-"));
  const persistTo = join(root, "state");
  // The Vitest global setup already migrated a template; copying it keeps the Node-only migration module out of the web type-check project.
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
}, 120_000);

afterAll(async () => {
  await runtime?.dispose();
  if (root) await rm(root, { recursive: true, force: true });
});

beforeEach(async () => {
  mail.sendEmailVerification.mockReset();
  await db.batch([
    db.prepare('DELETE FROM "Availability"'),
    db.prepare('DELETE FROM "Schedule"'),
    db.prepare('DELETE FROM "Membership"'),
    db.prepare('DELETE FROM "Profile"'),
    db.prepare('DELETE FROM "VerificationToken"'),
    db.prepare('DELETE FROM "TempOrgRedirect"'),
    db.prepare('DELETE FROM "UserPassword"'),
    db.prepare("DELETE FROM users"),
    db.prepare('DELETE FROM "Team"'),
  ]);
});

describe("self-hosted signup on D1", () => {
  it("creates an ordinary user, hashes the password, creates the default schedule and sends verification", async () => {
    const response = await signup({
      username: "New.User",
      email: "New.User@Example.test",
      password,
      language: "de",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ message: "Created user" });
    expect(await userRows()).toEqual([
      {
        id: expect.any(Number),
        email: "new.user@example.test",
        username: "new.user",
        emailVerified: null,
        identityProvider: "CAL",
        invitedTo: null,
      },
    ]);
    const stored = await db
      .prepare('SELECT hash FROM "UserPassword" WHERE userId=(SELECT id FROM users)')
      .first<{ hash: string }>();
    expect(await compare(password, stored!.hash)).toBe(true);
    expect(
      (await db.prepare('SELECT id FROM "Schedule" WHERE userId=(SELECT id FROM users)').all()).results
    ).toHaveLength(1);
    expect(
      (await db.prepare('SELECT id FROM "Availability" WHERE scheduleId=(SELECT id FROM "Schedule")').all())
        .results
    ).toHaveLength(1);
    expect(mail.sendEmailVerification).toHaveBeenCalledWith({
      email: "new.user@example.test",
      username: "new.user",
      language: "de",
    });
  });

  it("returns 409 for a duplicate email or username without changing rows or sending mail", async () => {
    await db
      .prepare(
        `INSERT INTO users (id, uuid, email, username, emailVerified) VALUES (1, 'taken', 'taken@example.test', 'taken', ?)`
      )
      .bind(future)
      .run();

    for (const body of [
      { username: "taken", email: "new@example.test", password },
      { username: "newname", email: "taken@example.test", password },
    ]) {
      const response = await signup(body);
      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: "Username or email is already taken" });
    }
    expect(await userRows()).toHaveLength(1);
    expect(mail.sendEmailVerification).not.toHaveBeenCalled();
  });

  it("returns 409 for a username reserved by a migration redirect", async () => {
    await db
      .prepare(
        `INSERT INTO "TempOrgRedirect" ("from", "fromOrgId", "type", "toUrl", "updatedAt")
         VALUES ('reserved', 0, 'user', 'https://example.test', ?)`
      )
      .bind(future)
      .run();

    const response = await signup({ username: "reserved", email: "reserved@example.test", password });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: "A user exists with that username" });
    expect(await userRows()).toEqual([]);
  });

  it("returns 422 for a username that slugifies to empty", async () => {
    const response = await signup({ username: "!!!", email: "invalid@example.test", password });

    expect(response.status).toBe(422);
    expect(await response.json()).toEqual({ message: "Invalid username" });
    expect(await userRows()).toEqual([]);
  });

  it("creates the invited user, accepts the membership and consumes the invite token", async () => {
    await db.batch([
      db.prepare(`INSERT INTO "Team" (id, name, slug) VALUES (10, 'Invited team', 'invited-team')`),
      db
        .prepare(
          `INSERT INTO "VerificationToken" ("identifier", "token", "expires", "updatedAt", "teamId")
           VALUES ('invitee@example.test', 'invite-token', ?, ?, 10)`
        )
        .bind(future, future),
    ]);

    const response = await signup({
      username: "ignored",
      email: "Invitee@Example.test",
      password,
      token: "invite-token",
    });

    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ message: "Created user" });
    expect(await userRows()).toEqual([
      {
        id: expect.any(Number),
        email: "invitee@example.test",
        username: "ignored",
        emailVerified: expect.any(String),
        identityProvider: "CAL",
        invitedTo: null,
      },
    ]);
    expect(
      await db.prepare('SELECT teamId,userId,accepted,role FROM "Membership" ORDER BY teamId').all()
    ).toMatchObject({ results: [{ teamId: 10, accepted: 1, role: "MEMBER" }] });
    expect((await db.prepare('SELECT id FROM "VerificationToken"').all()).results).toEqual([]);
    expect(mail.sendEmailVerification).not.toHaveBeenCalled();
  });

  it("returns 409 when the invited email belongs to another team invitation", async () => {
    await db.batch([
      db.prepare(`INSERT INTO "Team" (id, name, slug) VALUES (10, 'Invited team', 'invited-team')`),
      db.prepare(
        `INSERT INTO users (id, uuid, email, username, invitedTo) VALUES (1, 'invitee', 'invitee@example.test', 'other-name', 999)`
      ),
      db
        .prepare(
          `INSERT INTO "VerificationToken" ("identifier", "token", "expires", "updatedAt", "teamId")
           VALUES ('invitee@example.test', 'invite-token', ?, ?, 10)`
        )
        .bind(future, future),
    ]);

    const response = await signup({
      username: "new-invitee",
      email: "invitee@example.test",
      password,
      token: "invite-token",
    });

    expect(response.status).toBe(409);
    expect(await response.json()).toEqual({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS });
    expect((await db.prepare('SELECT id FROM "Membership"').all()).results).toEqual([]);
    expect((await db.prepare('SELECT id FROM "VerificationToken"').all()).results).toHaveLength(1);
  });

  it("maps a late unique conflict to 409 without leaving a user row", async () => {
    await db
      .prepare(
        `CREATE TRIGGER "fail_user_email" BEFORE INSERT ON "users"
         BEGIN SELECT RAISE(ABORT, 'UNIQUE constraint failed: users.email'); END`
      )
      .run();

    try {
      const response = await signup({
        username: "raced",
        email: "raced@example.test",
        password,
      });

      expect(response.status).toBe(409);
      expect(await response.json()).toEqual({ message: SIGNUP_ERROR_CODES.USER_ALREADY_EXISTS });
      expect(await userRows()).toEqual([]);
    } finally {
      await db.prepare('DROP TRIGGER IF EXISTS "fail_user_email"').run();
    }
  });

  it("rejects an expired invite token without creating the user", async () => {
    await db.batch([
      db.prepare(`INSERT INTO "Team" (id, name, slug) VALUES (10, 'Invited team', 'invited-team')`),
      db
        .prepare(
          `INSERT INTO "VerificationToken" ("identifier", "token", "expires", "updatedAt", "teamId")
           VALUES ('late@example.test', 'expired-token', '2000-01-01T00:00:00.000Z', ?, 10)`
        )
        .bind(future),
    ]);

    await expect(
      signup({ username: "late", email: "late@example.test", password, token: "expired-token" })
    ).rejects.toMatchObject({ statusCode: 401, message: "Token expired" });
    expect(await userRows()).toEqual([]);
  });
});
