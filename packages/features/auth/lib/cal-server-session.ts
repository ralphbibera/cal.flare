import { UserRepository } from "@calcom/features/users/repositories/UserRepository";
import { getUserAvatarUrl } from "@calcom/lib/getAvatarUrl";
import prisma from "@calcom/prisma";
import type { CalClaims, CalProfileContext } from "./cal-session";

export type CalServerSession = NonNullable<Awaited<ReturnType<typeof projectCalServerSession>>>;

export async function projectCalServerSession({
  claims,
  profile,
  expiresAt,
}: {
  claims: CalClaims;
  profile: CalProfileContext;
  expiresAt: Date;
}) {
  if (!claims.email || expiresAt.getTime() <= Date.now()) return null;
  const userFromDb = await prisma.user.findUnique({
    where: { id: claims.id },
    select: {
      id: true,
      uuid: true,
      name: true,
      username: true,
      email: true,
      emailVerified: true,
      completedOnboarding: true,
      role: true,
      avatarUrl: true,
      locale: true,
    },
  });
  if (!userFromDb) return null;
  const upId = profile.upId || `usr-${userFromDb.id}`;
  const [user, impersonatedBy] = await Promise.all([
    new UserRepository(prisma).enrichUserWithTheProfile({ user: userFromDb, upId }),
    claims.impersonatedBy?.id
      ? prisma.user.findUnique({
          where: { id: claims.impersonatedBy.id },
          select: { id: true, uuid: true, role: true },
        })
      : null,
  ]);
  return {
    hasValidLicense: true,
    expires: expiresAt.toISOString(),
    user: {
      id: user.id,
      uuid: user.uuid,
      name: user.name,
      username: user.username,
      email: user.email,
      emailVerified: user.emailVerified,
      email_verified: user.emailVerified !== null,
      completedOnboarding: user.completedOnboarding,
      role: user.role,
      image: getUserAvatarUrl({ avatarUrl: user.avatarUrl }),
      belongsToActiveTeam: claims.belongsToActiveTeam,
      // Session consumers expect an absent organization as undefined, not null.
      org: claims.org ?? undefined,
      orgAwareUsername: claims.orgAwareUsername,
      locale: user.locale ?? undefined,
      profile: user.profile,
      impersonatedBy: impersonatedBy ?? undefined,
    },
    profileId: profile.profileId,
    upId,
  };
}
