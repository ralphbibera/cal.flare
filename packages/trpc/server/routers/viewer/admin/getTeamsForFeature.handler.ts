import { scanKeysetBatches } from "@calcom/lib/keyset-scan";
import { createIlikeMatcher, type KeysetPage, toSqliteContainsPrefilter } from "@calcom/lib/postgres-ilike";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import type { TrpcSessionUser } from "../../../types";
import type { TAdminGetTeamsForFeatureSchema } from "./getTeamsForFeature.schema";

type GetTeamsOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
    prisma: PrismaClient;
  };
  input: TAdminGetTeamsForFeatureSchema;
};

const teamSelect = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  parentId: true,
  isOrganization: true,
  parent: {
    select: {
      name: true,
      logoUrl: true,
    },
  },
} satisfies Prisma.TeamSelect;

// SQLite LIKE folds only ASCII, so SQL narrows teams to candidates and ILIKE is confirmed here.
async function findSearchedTeams({
  prisma,
  searchTerm,
  cursor,
  limit,
}: {
  prisma: PrismaClient;
  searchTerm: string;
  cursor?: number | null;
  limit: number;
}) {
  const pattern = `%${searchTerm}%`;
  const matches = createIlikeMatcher(pattern);
  const contains = toSqliteContainsPrefilter(pattern);
  // The scan starts at the cursor row and drops the first match, as skip: 1 does on a cursor read.
  const skipped = cursor ? 1 : 0;
  const matched: Prisma.TeamGetPayload<{ select: typeof teamSelect }>[] = [];
  for await (const teams of scanKeysetBatches({
    after: cursor ?? undefined,
    getKey: (team) => team.id,
    fetchRows: ({ after, take }: KeysetPage) =>
      prisma.team.findMany({
        where: { isPlatform: false, OR: [{ name: { contains } }, { slug: { contains } }] },
        select: teamSelect,
        // id breaks name ties so each batch resumes exactly where the last one ended.
        orderBy: [{ name: "asc" }, { id: "asc" }],
        take,
        ...(after && { cursor: { id: after }, skip: after === cursor ? 0 : 1 }),
      }),
  })) {
    matched.push(...teams.filter((team) => matches(team.name) || matches(team.slug)));
    if (matched.length > limit + skipped) break;
  }
  return matched.slice(skipped, skipped + limit + 1);
}

export const getTeamsForFeatureHandler = async ({ ctx, input }: GetTeamsOptions) => {
  const { prisma } = ctx;
  const { featureId, limit = 10, cursor, searchTerm } = input;

  const [teams, assignedTeams] = await Promise.all([
    searchTerm
      ? findSearchedTeams({ prisma, searchTerm, cursor, limit })
      : prisma.team.findMany({
          where: { isPlatform: false },
          select: teamSelect,
          orderBy: {
            name: "asc",
          },
          take: limit + 1,
          ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
        }),
    prisma.teamFeatures.findMany({
      where: {
        featureId,
        enabled: true,
      },
      select: {
        teamId: true,
      },
    }),
  ]);

  const assignedTeamIds = new Set(assignedTeams.map((tf) => tf.teamId));

  let nextCursor: typeof cursor | undefined;
  if (teams.length > limit) {
    const nextItem = teams.pop();
    nextCursor = nextItem?.id;
  }

  return {
    teams: teams.map((team) => ({
      ...team,
      hasFeature: assignedTeamIds.has(team.id),
    })),
    nextCursor,
  };
};

export default getTeamsForFeatureHandler;
