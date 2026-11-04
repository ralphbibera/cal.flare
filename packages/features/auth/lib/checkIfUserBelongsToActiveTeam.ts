import { IS_TEAM_BILLING_ENABLED } from "@calcom/lib/constants";
import type { Membership, Team } from "@calcom/prisma/client";
import { teamMetadataSchema } from "@calcom/prisma/zod-utils";

type UserTeams = {
  teams: (Membership & {
    team: Pick<Team, "metadata">;
  })[];
};

export const checkIfUserBelongsToActiveTeam = <T extends UserTeams>(user: T) =>
  user.teams.some((m: { team: { metadata: unknown } }) => {
    if (!IS_TEAM_BILLING_ENABLED) {
      return true;
    }

    const metadata = teamMetadataSchema.safeParse(m.team.metadata);

    return metadata.success && metadata.data?.subscriptionId;
  });
