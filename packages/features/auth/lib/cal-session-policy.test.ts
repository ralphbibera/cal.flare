import prismock from "@calcom/testing/lib/__mocks__/prisma";
import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { projectCalServerSession } from "./cal-server-session";
import { browserSession, calClaimsSchema } from "./cal-session";
import { calSessionUpdateSchema, refreshCalSession, updateCalSession } from "./cal-session-policy";

async function principals() {
  const owner = await prismock.user.create({
    data: {
      email: "owner@calflare.test",
      username: "owner",
      role: "ADMIN",
      locale: "de",
      emailVerified: new Date("2020-01-01T00:00:00Z"),
    },
  });
  const other = await prismock.user.create({ data: { email: "other@calflare.test", username: "other" } });
  const org = await prismock.team.create({
    data: { name: "Synthetic organization", slug: "synthetic", isOrganization: true },
  });
  const otherProfile = await prismock.profile.create({
    data: {
      uid: ProfileRepository.generateProfileUid(),
      userId: other.id,
      organizationId: org.id,
      username: "other-org",
    },
  });
  return {
    owner,
    other,
    org,
    otherProfile,
    snapshot: {
      claims: calClaimsSchema.parse({
        id: owner.id,
        email: owner.email,
        name: "Browser name",
        role: "INACTIVE_ADMIN",
        inactiveAdminReason: "both",
        locale: "ar",
      }),
      profile: { profileId: null, upId: `usr-${owner.id}` },
    },
  };
}

let state: Awaited<ReturnType<typeof principals>>;
beforeEach(async () => {
  state = await principals();
});

describe("Cal session ownership (synthetic ORM, not application login acceptance)", () => {
  it("rejects an email update that selects another authenticated identity", async () => {
    await expect(updateCalSession(state.snapshot, { email: state.other.email })).rejects.toMatchObject({
      code: "forbidden_error",
    });
  });

  it("rejects cross-user refresh before reading that principal's profile or memberships", async () => {
    const profiles = vi.spyOn(ProfileRepository, "findAllProfilesForUserIncludingMovedUser");
    try {
      await expect(
        refreshCalSession({
          ...state.snapshot,
          claims: { ...state.snapshot.claims, email: state.other.email },
        })
      ).rejects.toMatchObject({ code: "forbidden_error" });
      expect(profiles).not.toHaveBeenCalled();
    } finally {
      profiles.mockRestore();
    }
  });

  it("retains source nullish update defaults and never accepts role or identity promotion", async () => {
    const updated = await updateCalSession(
      state.snapshot,
      calSessionUpdateSchema.parse({
        id: state.other.id,
        role: "ADMIN",
        locale: null,
        name: "Updated",
        email: state.owner.email,
      })
    );
    expect(updated.claims).toMatchObject({
      id: state.owner.id,
      role: "INACTIVE_ADMIN",
      inactiveAdminReason: "both",
      locale: "ar",
      name: "Updated",
    });
    const changedEmail = await updateCalSession(state.snapshot, { email: "changed@calflare.test" });
    expect(changedEmail.claims.email).toBe("changed@calflare.test");
    expect(await refreshCalSession(changedEmail)).toEqual(changedEmail);
  });

  it("rejects both foreign profile identifiers and foreign profile context", async () => {
    await expect(
      updateCalSession(state.snapshot, {
        upId: `prof-${state.otherProfile.uid}`,
        profileId: state.otherProfile.id,
      })
    ).rejects.toMatchObject({ code: "forbidden_error" });
    await expect(
      updateCalSession(state.snapshot, { profileId: state.otherProfile.id })
    ).rejects.toMatchObject({ code: "forbidden_error" });
  });

  it("retains repository-authorized moved profile access rather than requiring profile userId equality", async () => {
    await prismock.membership.create({
      data: { userId: state.owner.id, teamId: state.org.id, role: "MEMBER", accepted: true },
    });
    await prismock.user.update({
      where: { id: state.owner.id },
      data: { movedToProfileId: state.otherProfile.id },
    });
    const next = await updateCalSession(state.snapshot, {
      upId: `prof-${state.otherProfile.uid}`,
      profileId: state.otherProfile.id,
    });
    expect(next.profile).toEqual({
      upId: `prof-${state.otherProfile.uid}`,
      profileId: state.otherProfile.id,
    });
    expect(next.claims.id).toBe(state.owner.id);
  });

  it("preserves distinct browser and DB-enriched server roles, license and locale", async () => {
    const expiresAt = new Date(Date.now() + 120_000);
    const browser = browserSession(state.snapshot.claims, state.snapshot.profile);
    const server = await projectCalServerSession({ ...state.snapshot, expiresAt });
    expect(browser).toMatchObject({
      hasValidLicense: false,
      user: { role: "INACTIVE_ADMIN", inactiveAdminReason: "both", locale: "ar" },
    });
    expect(server).toMatchObject({
      hasValidLicense: true,
      expires: expiresAt.toISOString(),
      user: {
        id: state.owner.id,
        uuid: state.owner.uuid,
        role: "ADMIN",
        locale: "de",
        emailVerified: state.owner.emailVerified,
        email_verified: true,
      },
    });
    expect(server?.user).not.toHaveProperty("inactiveAdminReason");
    expect(JSON.stringify(server)).not.toMatch(/password|twoFactorSecret|backupCodes|credential/);
    expect(await projectCalServerSession({ ...state.snapshot, expiresAt: new Date(0) })).toBeNull();
  });
});
