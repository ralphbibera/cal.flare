import { hashAPIKey } from "@calcom/features/api-keys-legacy/api-keys/lib/apiKeys";
import { IS_PREMIUM_USERNAME_ENABLED } from "@calcom/lib/constants";
import prisma from "@calcom/prisma";
import { IdentityProvider, MembershipRole, RedirectType } from "@calcom/prisma/enums";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { hash } from "bcryptjs";
import { describe, expect } from "vitest";
import { createHandler } from "../apiKeys/create.handler";
import { deleteHandler } from "../apiKeys/delete.handler";
import { listHandler } from "../apiKeys/list.handler";
import { changePasswordHandler } from "../auth/changePassword.handler";
import { updateProfileHandler } from "./updateProfile.handler";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../apps/web/cloudflare.config")).default.worker,
});

const oldPassword = "Old-Password-123";
const newPassword = "New-Password-456";
let counter = 0;

type UserOverrides = Partial<{
  username: string;
  email: string;
  name: string;
  bio: string | null;
  theme: string | null;
  identityProvider: IdentityProvider;
}>;

const createUser = (overrides: UserOverrides = {}) => {
  counter += 1;
  return prisma.user.create({
    data: {
      username: `settings-user-${counter}`,
      email: `settings-user-${counter}@example.com`,
      name: `Settings User ${counter}`,
      timeZone: "Europe/London",
      locale: "en",
      metadata: {},
      ...overrides,
    },
  });
};

const profile = (user: Awaited<ReturnType<typeof createUser>>) =>
  updateProfileHandler({
    ctx: { user: user as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"] },
    input: {},
  });

d1.beforeEach(async () => {
  await d1.db.batch([
    d1.db.prepare('DELETE FROM "ApiKey"'),
    d1.db.prepare('DELETE FROM "App"'),
    d1.db.prepare('DELETE FROM "TempOrgRedirect"'),
    d1.db.prepare('DELETE FROM "UserPassword"'),
    d1.db.prepare('DELETE FROM "TravelSchedule"'),
    d1.db.prepare('DELETE FROM "Schedule"'),
    d1.db.prepare('DELETE FROM "SecondaryEmail"'),
    d1.db.prepare('DELETE FROM "Membership"'),
    d1.db.prepare('DELETE FROM "Team"'),
    d1.db.prepare('DELETE FROM "Feature"'),
    d1.db.prepare("DELETE FROM users"),
  ]);
});

describe("updateProfile on D1", () => {
  d1.test("saves profile, general and appearance fields", async () => {
    const user = await createUser();

    const result = await updateProfileHandler({
      ctx: { user: user as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"] },
      input: {
        name: "Renamed",
        username: "renamed-settings-user",
        timeZone: "America/New_York",
        locale: "de",
        theme: "dark",
        timeFormat: 12,
        metadata: { sessionTimeout: 30 },
      },
    });

    expect(result).toMatchObject({ name: "Renamed", username: "renamed-settings-user", theme: "dark" });
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: {
          name: true,
          username: true,
          timeZone: true,
          locale: true,
          theme: true,
          timeFormat: true,
          metadata: true,
        },
      })
    ).toEqual({
      name: "Renamed",
      username: "renamed-settings-user",
      timeZone: "America/New_York",
      locale: "de",
      theme: "dark",
      timeFormat: 12,
      metadata: { sessionTimeout: 30 },
    });
  });

  d1.test("rejects a migration-reserved username without writing the profile", async () => {
    const user = await createUser();
    await prisma.tempOrgRedirect.create({
      data: {
        from: "reserved-settings-user",
        fromOrgId: 0,
        type: RedirectType.User,
        toUrl: "https://example.com",
      },
    });

    await expect(
      updateProfileHandler({
        ctx: { user: user as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"] },
        input: { name: "Should not persist", username: "reserved-settings-user" },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Username is already taken" });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { name: true } })).toEqual({
      name: user.name,
    });
  });

  d1.test("surfaces the unique violation for a username owned by another account", async () => {
    const user = await createUser();
    const other = await createUser();

    const attempt = updateProfileHandler({
      ctx: { user: user as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"] },
      input: { username: other.username },
    });
    if (IS_PREMIUM_USERNAME_ENABLED) {
      await expect(attempt).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "Username is already taken",
      });
    } else {
      await expect(attempt).rejects.toMatchObject({ code: "P2002" });
    }
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { username: true } })
    ).toEqual({ username: user.username });
  });

  d1.test("maps a duplicate primary email to 409", async () => {
    const user = await createUser();
    const other = await createUser();

    await expect(
      updateProfileHandler({
        ctx: { user: user as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"] },
        input: { email: other.email },
      })
    ).rejects.toMatchObject({ statusCode: 409, message: "email_already_used" });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } })).toEqual({
      email: user.email,
    });
  });

  d1.test("rejects an invalid booker layout", async () => {
    const user = await createUser();

    await expect(
      updateProfileHandler({
        ctx: { user: user as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"] },
        input: {
          metadata: {
            defaultBookerLayouts: { enabledLayouts: [], defaultLayout: "month_view" },
          },
        },
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "At least one layout has to be enabled.",
    });
  });

  d1.test("moves the default schedule to the new timezone", async () => {
    const user = await createUser();
    const schedule = await prisma.schedule.create({
      data: { userId: user.id, name: "Working hours", timeZone: "Europe/London" },
    });

    await updateProfileHandler({
      ctx: { user: user as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"] },
      input: { timeZone: "America/New_York" },
    });

    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { defaultScheduleId: true } })
    ).toEqual({ defaultScheduleId: schedule.id });
    expect(
      await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id }, select: { timeZone: true } })
    ).toEqual({ timeZone: "America/New_York" });
  });

  d1.test("replaces travel schedules and keeps omitted values distinct from explicit nulls", async () => {
    const user = await createUser({ name: "Keep", bio: "old bio", theme: "dark" });
    const keep = await prisma.travelSchedule.create({
      data: { userId: user.id, timeZone: "Asia/Tokyo", startDate: new Date("2030-01-01") },
    });
    const remove = await prisma.travelSchedule.create({
      data: { userId: user.id, timeZone: "Asia/Seoul", startDate: new Date("2030-02-01") },
    });

    await updateProfileHandler({
      ctx: { user: user as unknown as Parameters<typeof updateProfileHandler>[0]["ctx"]["user"] },
      input: {
        bio: null,
        theme: null,
        travelSchedules: [
          { id: keep.id, timeZone: "Asia/Tokyo", startDate: new Date("2030-01-01") },
          { timeZone: "Europe/Paris", startDate: new Date("2030-03-01") },
        ],
      },
    });

    expect(
      await prisma.travelSchedule.findMany({
        where: { userId: user.id },
        select: { id: true, timeZone: true },
        orderBy: { id: "asc" },
      })
    ).toEqual([
      { id: keep.id, timeZone: "Asia/Tokyo" },
      { id: expect.any(Number), timeZone: "Europe/Paris" },
    ]);
    expect(
      await prisma.travelSchedule.findUnique({ where: { id: remove.id }, select: { id: true } })
    ).toBeNull();
    expect(
      await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
        select: { name: true, bio: true, theme: true },
      })
    ).toEqual({ name: "Keep", bio: null, theme: null });
  });

  d1.test("leaves an unchanged email untouched", async () => {
    const user = await createUser();

    const result = await profile(user);
    expect(result).toMatchObject({ hasEmailBeenChanged: undefined, email: undefined });
    expect(await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { email: true } })).toEqual({
      email: user.email,
    });
  });
});

describe("changePassword on D1", () => {
  const passwordUser = (identityProvider = IdentityProvider.CAL) => createUser({ identityProvider });

  d1.test("hashes and upserts a valid new password", async () => {
    const user = await passwordUser();
    await prisma.userPassword.create({ data: { userId: user.id, hash: await hash(oldPassword, 12) } });

    await changePasswordHandler({
      ctx: { user: user as unknown as Parameters<typeof changePasswordHandler>[0]["ctx"]["user"] },
      input: { oldPassword, newPassword },
    });

    const stored = await prisma.userPassword.findUniqueOrThrow({ where: { userId: user.id } });
    expect(stored.hash).not.toBe(await hash(oldPassword, 12));
    const { compare } = await import("bcryptjs");
    expect(await compare(newPassword, stored.hash)).toBe(true);
  });

  d1.test("distinguishes third-party, missing, incorrect, equal and weak passwords", async () => {
    const thirdParty = await passwordUser(IdentityProvider.GOOGLE);
    await expect(
      changePasswordHandler({
        ctx: { user: thirdParty as unknown as Parameters<typeof changePasswordHandler>[0]["ctx"]["user"] },
        input: { oldPassword, newPassword },
      })
    ).rejects.toMatchObject({ code: "FORBIDDEN", message: "THIRD_PARTY_IDENTITY_PROVIDER_ENABLED" });

    const withoutPassword = await passwordUser();
    await expect(
      changePasswordHandler({
        ctx: {
          user: withoutPassword as unknown as Parameters<typeof changePasswordHandler>[0]["ctx"]["user"],
        },
        input: { oldPassword, newPassword },
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "MISSING_PASSWORD" });

    const user = await passwordUser();
    const oldHash = await hash(oldPassword, 12);
    await prisma.userPassword.create({ data: { userId: user.id, hash: oldHash } });
    const ctx = {
      user: user as unknown as Parameters<typeof changePasswordHandler>[0]["ctx"]["user"],
    };
    await expect(
      changePasswordHandler({ ctx, input: { oldPassword: "wrong-password", newPassword } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "incorrect_password" });
    await expect(
      changePasswordHandler({ ctx, input: { oldPassword, newPassword: oldPassword } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "new_password_matches_old_password" });
    await expect(
      changePasswordHandler({ ctx, input: { oldPassword, newPassword: "weak" } })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "password_hint_min" });
    expect(await prisma.userPassword.findUniqueOrThrow({ where: { userId: user.id } })).toEqual({
      userId: user.id,
      hash: oldHash,
    });
  });

  d1.test("allows a third-party identity that has a local password", async () => {
    const user = await passwordUser(IdentityProvider.GOOGLE);
    await prisma.userPassword.create({ data: { userId: user.id, hash: await hash(oldPassword, 12) } });

    await changePasswordHandler({
      ctx: { user: user as unknown as Parameters<typeof changePasswordHandler>[0]["ctx"]["user"] },
      input: { oldPassword, newPassword },
    });

    expect(await prisma.userPassword.findUniqueOrThrow({ where: { userId: user.id } })).toMatchObject({
      userId: user.id,
    });
  });
});

describe("developer API keys on D1", () => {
  d1.test("returns one plaintext key and stores only its hash with a null expiry", async () => {
    const user = await createUser();

    const apiKey = await createHandler({
      ctx: { user: { id: user.id } },
      input: { note: "personal", neverExpires: true },
    });

    expect(apiKey).toMatch(/^cal_[0-9a-f]{32}$/);
    const stored = await prisma.apiKey.findFirstOrThrow({ where: { userId: user.id } });
    expect(stored).toMatchObject({
      note: "personal",
      teamId: null,
      expiresAt: null,
      hashedKey: hashAPIKey(apiKey.replace(/^cal_/, "")),
    });
    expect(stored.hashedKey).not.toContain(apiKey.replace(/^cal_/, ""));
  });

  d1.test("persists an explicit expiry", async () => {
    const user = await createUser();
    const expiresAt = new Date("2030-01-01T00:00:00.000Z");

    await createHandler({ ctx: { user: { id: user.id } }, input: { note: "expiring", expiresAt } });

    expect(await prisma.apiKey.findFirstOrThrow({ where: { userId: user.id } })).toMatchObject({ expiresAt });
  });

  d1.test("allows team admins and owners but denies members", async () => {
    const owner = await createUser();
    const member = await createUser();
    const team = await prisma.team.create({ data: { name: "Key team", slug: `key-team-${counter}` } });
    await prisma.membership.create({
      data: { teamId: team.id, userId: owner.id, role: MembershipRole.ADMIN, accepted: true },
    });
    await prisma.membership.create({
      data: { teamId: team.id, userId: member.id, role: MembershipRole.MEMBER, accepted: true },
    });

    await expect(
      createHandler({ ctx: { user: { id: owner.id } }, input: { teamId: team.id, neverExpires: true } })
    ).resolves.toMatch(/^cal_[0-9a-f]{32}$/);
    expect(await prisma.apiKey.count({ where: { teamId: team.id } })).toBe(1);

    await expect(
      createHandler({ ctx: { user: { id: member.id } }, input: { teamId: team.id, neverExpires: true } })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await prisma.apiKey.count({ where: { teamId: team.id } })).toBe(1);
  });

  d1.test("lists only the owner's non-zapier keys and deletes only its own key", async () => {
    const user = await createUser();
    const other = await createUser();
    const personal = await prisma.apiKey.create({
      data: { id: "personal-key", userId: user.id, hashedKey: "hash-personal", note: "personal" },
    });
    await prisma.app.create({ data: { slug: "zapier", dirName: "zapier" } });
    await prisma.apiKey.create({
      data: { id: "zapier-key", userId: user.id, hashedKey: "hash-zapier", appId: "zapier" },
    });
    const foreign = await prisma.apiKey.create({
      data: { id: "foreign-key", userId: other.id, hashedKey: "hash-foreign" },
    });

    const listed = await listHandler({
      ctx: {
        user: user as unknown as Parameters<typeof listHandler>[0]["ctx"]["user"],
        prisma,
      },
    });
    expect(listed.map(({ id }) => id)).toEqual([personal.id]);

    await expect(
      deleteHandler({
        ctx: { user: user as unknown as Parameters<typeof deleteHandler>[0]["ctx"]["user"] },
        input: { id: foreign.id },
      })
    ).rejects.toBeDefined();
    expect(await prisma.apiKey.findUnique({ where: { id: foreign.id } })).not.toBeNull();

    await expect(
      deleteHandler({
        ctx: { user: user as unknown as Parameters<typeof deleteHandler>[0]["ctx"]["user"] },
        input: { id: personal.id },
      })
    ).resolves.toEqual({ id: personal.id });
    expect(await prisma.apiKey.findUnique({ where: { id: personal.id } })).toBeNull();
  });
});
