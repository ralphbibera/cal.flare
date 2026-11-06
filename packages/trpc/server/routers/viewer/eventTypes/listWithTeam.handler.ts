import db from "@calcom/prisma";
import type { TrpcSessionUser } from "../../../types";

type ListWithTeamOptions = {
  ctx: {
    user: Pick<NonNullable<TrpcSessionUser>, "id">;
  };
};

export const listWithTeamHandler = async ({ ctx }: ListWithTeamOptions) => {
  const userId = ctx.user.id;
  const eventTypes = await db.eventType.findMany({
    where: {
      OR: [{ userId }, { team: { members: { some: { userId, accepted: true } } } }],
    },
    select: {
      id: true,
      teamId: true,
      title: true,
      slug: true,
      length: true,
      team: { select: { name: true } },
      owner: { select: { username: true } },
    },
  });

  return eventTypes.map((eventType) => ({
    id: eventType.id,
    team: eventType.teamId ? { id: eventType.teamId, name: eventType.team?.name || "" } : null,
    title: eventType.title,
    slug: eventType.slug,
    length: eventType.length,
    username: eventType.teamId ? null : (eventType.owner?.username ?? null),
  }));
};
