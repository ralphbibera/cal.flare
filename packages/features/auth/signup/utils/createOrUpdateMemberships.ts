import { ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { prisma } from "@calcom/prisma";
import type { OrganizationSettings, Team, User } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { d1Boolean, d1DateTime, runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
import { MembershipRole } from "@calcom/prisma/enums";
import { MembershipSchema } from "@calcom/prisma/zod/modelSchema/MembershipSchema";
import { getOrgUsernameFromEmail } from "./getOrgUsernameFromEmail";

type ParentTeamData = {
  id: number;
  organizationSettings?: Pick<OrganizationSettings, "orgAutoAcceptEmail"> | null;
};

const membershipRow = MembershipSchema.extend({
  accepted: d1Boolean,
  createdAt: d1DateTime.nullable(),
  updatedAt: d1DateTime.nullable(),
});

export const createOrUpdateMemberships = async ({
  user,
  team,
}: {
  user: Pick<User, "id">;
  team: Pick<Team, "id" | "parentId" | "isOrganization"> & {
    organizationSettings?: Pick<OrganizationSettings, "orgAutoAcceptEmail"> | null;
    parent?: ParentTeamData | null;
  };
}) => {
  const db = getD1Database();
  const now = toD1DateTime(new Date());
  // Determine the organization context - either the team itself (if it's an org) or its parent
  const organizationId = team.isOrganization ? team.id : (team.parent?.id ?? null);
  const orgSettings = team.isOrganization
    ? team.organizationSettings
    : (team.parent?.organizationSettings ?? null);
  const upsertAcceptedMembership = (teamId: number) =>
    db
      .prepare(
        `INSERT INTO "Membership" ("userId", "teamId", "role", "accepted", "updatedAt") VALUES (?, ?, ?, 1, ?)
        ON CONFLICT ("userId", "teamId") DO UPDATE SET "accepted" = 1, "updatedAt" = excluded."updatedAt"`
      )
      .bind(user.id, teamId, MembershipRole.MEMBER, now);

  const statements = [];
  // Create profile if user is joining an organization context (either directly or via sub-team)
  if (organizationId) {
    const dbUser = await prisma.user.findUnique({
      where: { id: user.id },
      select: { email: true },
    });
    if (dbUser) {
      // The stored username wins inside the batch; the email fallback covers a null or empty one.
      // This method being called only during signup means that the username should be the correct org username
      const fallbackUsername = getOrgUsernameFromEmail(dbUser.email, orgSettings?.orgAutoAcceptEmail ?? null);
      statements.push(
        db
          .prepare(
            `INSERT INTO "Profile" ("uid", "userId", "organizationId", "username", "updatedAt")
            SELECT ?, "id", ?, COALESCE(NULLIF("username", ''), ?), ? FROM "users" WHERE "id" = ?
            ON CONFLICT ("userId", "organizationId")
            DO UPDATE SET "username" = excluded."username", "updatedAt" = excluded."updatedAt"`
          )
          .bind(ProfileRepository.generateProfileUid(), organizationId, fallbackUsername, now, user.id)
      );
    }
  }
  statements.push(upsertAcceptedMembership(team.id));
  const selection = statements.length;
  statements.push(
    db.prepare('SELECT * FROM "Membership" WHERE "userId" = ? AND "teamId" = ?').bind(user.id, team.id)
  );
  if (team.parentId) statements.push(upsertAcceptedMembership(team.parentId));

  const results = await runD1Batch(db, statements, { modelName: "Membership" });
  const membership = membershipRow.parse(results[selection].results[0]);
  const orgMembership = null;
  return { membership, orgMembership };
};
