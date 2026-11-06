import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { prisma } from "@calcom/prisma";
import type { OrganizationSettings, Team } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { requireD1Record, runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
import { getOrgUsernameFromEmail } from "./getOrgUsernameFromEmail";

export async function joinAnyChildTeamOnOrgInvite({
  userId,
  org,
}: {
  userId: number;
  org: Pick<Team, "id"> & {
    organizationSettings: OrganizationSettings | null;
  };
}) {
  const user = await prisma.user.findUnique({
    where: {
      id: userId,
    },
    select: { id: true, username: true, email: true },
  });
  if (!user) {
    throw new Error("User not found");
  }

  const orgUsername =
    user.username ||
    getOrgUsernameFromEmail(user.email, org.organizationSettings?.orgAutoAcceptEmail ?? null);

  const db = getD1Database();
  const now = toD1DateTime(new Date());
  await runD1Batch(
    db,
    [
      requireD1Record(
        db,
        { modelName: "User", operation: "an update" },
        'SELECT 1 FROM "users" WHERE "id" = ?',
        userId
      ),
      // Simply remove this update when we remove the `organizationId` field from the user table
      db
        .prepare('UPDATE "users" SET "organizationId" = ? WHERE "id" = ?')
        .bind(org.id, userId),
      db
        .prepare(
          `INSERT INTO "Profile" ("uid", "userId", "organizationId", "username", "updatedAt") VALUES (?, ?, ?, ?, ?)
          ON CONFLICT ("userId", "organizationId")
          DO UPDATE SET "username" = excluded."username", "updatedAt" = excluded."updatedAt"`
        )
        .bind(ProfileRepository.generateProfileUid(), userId, org.id, orgUsername, now),
      db
        .prepare(
          'UPDATE "Membership" SET "accepted" = 1, "updatedAt" = ? WHERE "userId" = ? AND "teamId" = ? AND "accepted" = 0'
        )
        .bind(now, userId, org.id),
      db
        .prepare(
          `UPDATE "Membership" SET "accepted" = 1, "updatedAt" = ? WHERE "userId" = ? AND "accepted" = 0
          AND "teamId" IN (SELECT "id" FROM "Team" WHERE "parentId" = ?)`
        )
        .bind(now, userId, org.id),
    ],
    { modelName: "Profile" }
  );
}
