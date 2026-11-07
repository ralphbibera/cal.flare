import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { ENABLE_PROFILE_SWITCHER, WEBAPP_URL } from "@calcom/lib/constants";
import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import prisma from "@calcom/prisma";
import { userMetadata } from "@calcom/prisma/zod-utils";
import { z } from "zod";
import type { credentialSession } from "./cal-session";
import { calClaimsSchema } from "./cal-session";
import { checkIfUserBelongsToActiveTeam } from "./checkIfUserBelongsToActiveTeam";

type CalSessionSnapshot = ReturnType<typeof credentialSession>;

export const calSessionUpdateSchema = z.object({
  profileId: z.number().int().positive().nullable().optional(),
  upId: z.string().nullable().optional(),
  locale: z.string().nullable().optional(),
  name: z.string().nullable().optional(),
  username: z.string().nullable().optional(),
  email: z.string().nullable().optional(),
});

export async function getCalSessionSettings(userId: number) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { metadata: true, emailVerified: true },
  });
  return {
    sessionTimeout: user ? userMetadata.parse(user.metadata)?.sessionTimeout : undefined,
    emailVerified: Boolean(user?.emailVerified),
  };
}

export async function updateCalSession(
  snapshot: CalSessionSnapshot,
  update: z.infer<typeof calSessionUpdateSchema>
) {
  const { claims, profile } = snapshot;
  const nextProfile = {
    profileId: update.profileId ?? profile.profileId ?? null,
    upId: update.upId ?? profile.upId ?? null,
  };
  if (update.email && update.email !== claims.email) {
    const selected = await prisma.user.findFirst({ where: { email: update.email }, select: { id: true } });
    if (selected && selected.id !== claims.id) {
      throw new ErrorWithCode(ErrorCode.Forbidden, "Session email resolves to another Cal identity");
    }
  }
  if (nextProfile.upId) {
    const owned = await ProfileRepository.findByUpIdWithAuth(nextProfile.upId, claims.id);
    if (!owned) {
      throw new ErrorWithCode(ErrorCode.Forbidden, "Session profile is not accessible");
    }
  } else if (nextProfile.profileId !== null) {
    throw new ErrorWithCode(ErrorCode.Forbidden, "Session profile requires its owned identifier");
  }
  if (
    nextProfile.profileId !== null &&
    !(await ProfileRepository.findByUpIdWithAuth(String(nextProfile.profileId), claims.id))
  ) {
    throw new ErrorWithCode(ErrorCode.Forbidden, "Session profile is not accessible");
  }
  return {
    claims: {
      ...claims,
      locale: update.locale ?? claims.locale ?? "en",
      name: update.name ?? claims.name,
      username: update.username ?? claims.username,
      email: update.email ?? claims.email,
    },
    profile: nextProfile,
  };
}

export async function refreshCalSession(snapshot: CalSessionSnapshot): Promise<CalSessionSnapshot> {
  const { claims } = snapshot;
  const user = await prisma.user.findFirst({
    where: { email: claims.email },
    select: {
      id: true,
      username: true,
      avatarUrl: true,
      name: true,
      email: true,
      role: true,
      locale: true,
      movedToProfileId: true,
      teams: {
        select: {
          id: true,
          userId: true,
          teamId: true,
          role: true,
          accepted: true,
          createdAt: true,
          updatedAt: true,
          customRoleId: true,
          team: { select: { id: true, metadata: true } },
        },
      },
    },
  });
  if (!user) return snapshot;
  // SECURITY CORRECTION: mutable browser email cannot select another principal's profile or team claims.
  if (user.id !== claims.id) {
    throw new ErrorWithCode(ErrorCode.Forbidden, "Session email resolves to another Cal identity");
  }
  const profiles = await ProfileRepository.findAllProfilesForUserIncludingMovedUser(user);
  const selected = ENABLE_PROFILE_SWITCHER && snapshot.profile.upId ? snapshot.profile : profiles[0];
  if (!selected?.upId) throw new ErrorWithCode(ErrorCode.Forbidden, "Session profile is missing");
  // A browser email update never transfers ownership of the authenticated Cal identity.
  const profile = await ProfileRepository.findByUpIdWithAuth(selected.upId, claims.id);
  if (!profile) throw new ErrorWithCode(ErrorCode.Forbidden, "Session profile is not accessible");
  const org = profile.organization;
  const membership = org
    ? await prisma.membership.findUnique({
        where: { userId_teamId: { userId: claims.id, teamId: org.id } },
        select: { role: true },
      })
    : null;
  return {
    claims: calClaimsSchema.parse({
      name: user.name,
      username: user.username,
      role: user.role,
      locale: user.locale,
      ...claims,
      belongsToActiveTeam: checkIfUserBelongsToActiveTeam(user),
      orgAwareUsername: org ? profile.username : user.username,
      org:
        org && !org.isPlatform
          ? {
              id: org.id,
              name: org.name,
              slug: org.slug ?? "",
              logoUrl: org.logoUrl,
              fullDomain: WEBAPP_URL,
              domainSuffix: "",
              role: membership?.role,
            }
          : null,
    }),
    profile: { profileId: profile.id, upId: selected.upId },
  };
}
