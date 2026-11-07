import { checkAdminOrOwner } from "@calcom/features/auth/lib/checkAdminOrOwner";
import { getTranslation } from "@calcom/i18n/server";
import prisma from "@calcom/prisma";
import { D1_IN_LIST_CHUNK_SIZE } from "@calcom/prisma/d1";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { TRPCError } from "@trpc/server";
import type { TOutOfOfficeEntriesListSchema } from "./outOfOfficeEntriesList.schema";

type GetOptions = {
  ctx: {
    user: NonNullable<TrpcSessionUser>;
  };
  input: TOutOfOfficeEntriesListSchema;
};

export const outOfOfficeEntriesList = async ({ ctx, input }: GetOptions) => {
  const t = await getTranslation(ctx.user.locale, "common");
  const {
    cursor,
    limit,
    fetchTeamMembersEntries,
    searchTerm,
    endDateFilterStartRange,
    endDateFilterEndRange,
  } = input;
  let fetchOOOEntriesForIds = [ctx.user.id];
  let reportingUserIds = [0];

  if (fetchTeamMembersEntries) {
    // Get teams of context user
    const teams = await prisma.membership.findMany({
      where: {
        userId: ctx.user.id,
        accepted: true,
      },
      select: {
        teamId: true,
        role: true,
      },
    });
    if (teams.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: t("user_has_no_team_yet") });
    }
    const ownerOrAdminTeamIds = teams
      .filter((team) => checkAdminOrOwner(team.role))
      .map((team) => team.teamId);

    // Fetch team member userIds
    const teamMembers = await prisma.team.findMany({
      where: {
        id: {
          in: teams.map((team) => team.teamId),
        },
      },
      select: {
        id: true,
        members: {
          select: {
            userId: true,
            accepted: true,
          },
        },
      },
    });
    const userIds = teamMembers
      .flatMap((team) => team.members.filter((member) => member.accepted).map((member) => member.userId))
      .filter((id) => id !== ctx.user.id);
    if (userIds.length === 0) {
      throw new TRPCError({ code: "NOT_FOUND", message: t("no_team_members") });
    }
    fetchOOOEntriesForIds = userIds;

    const adminTeams = teamMembers.filter(({ id }) => ownerOrAdminTeamIds.includes(id));

    reportingUserIds = adminTeams.flatMap(({ members }) =>
      members.filter(({ accepted, userId }) => accepted && userId !== ctx.user.id).map(({ userId }) => userId)
    );
  }

  const entriesWhere = {
    end: {
      gte: endDateFilterStartRange ?? new Date().toISOString(),
      lte: endDateFilterEndRange,
    },
    ...(searchTerm
      ? {
          OR: [
            { notes: { contains: searchTerm } },
            { reason: { reason: { contains: searchTerm } } },
            {
              toUser: {
                OR: [{ email: { contains: searchTerm } }, { name: { contains: searchTerm } }],
              },
            },
            ...(fetchTeamMembersEntries
              ? [
                  {
                    user: {
                      OR: [{ email: { contains: searchTerm } }, { name: { contains: searchTerm } }],
                    },
                  },
                ]
              : []),
          ],
        }
      : {}),
  };
  const whereFor = (userIds: number[]) => ({ ...entriesWhere, userId: { in: userIds } });
  const outOfOfficeSelect = {
    id: true,
    uuid: true,
    start: true,
    end: true,
    toUserId: true,
    toUser: {
      select: {
        username: true,
        name: true,
        email: true,
      },
    },
    reason: {
      select: {
        id: true,
        emoji: true,
        reason: true,
        userId: true,
      },
    },
    notes: true,
    showNotePublicly: true,
    user: fetchTeamMembersEntries
      ? {
          select: {
            id: true,
            username: true,
            email: true,
            avatarUrl: true,
            name: true,
          },
        }
      : false,
  };
  const fetchEntries = (userIds: number[], take?: number, after?: number | null) =>
    prisma.outOfOfficeEntry.findMany({
      where: whereFor(userIds),
      select: outOfOfficeSelect,
      orderBy: take ? { start: "asc" } : [{ start: "asc" }, { id: "asc" }],
      cursor: after ? { id: after } : undefined,
      take,
    });

  const selectedUserIds = Array.from(new Set(fetchOOOEntriesForIds));
  let getTotalEntries: number;
  let outOfOfficeEntries: Awaited<ReturnType<typeof fetchEntries>>;
  if (selectedUserIds.length <= D1_IN_LIST_CHUNK_SIZE) {
    [getTotalEntries, outOfOfficeEntries] = await Promise.all([
      prisma.outOfOfficeEntry.count({ where: whereFor(selectedUserIds) }),
      fetchEntries(selectedUserIds, limit + 1, cursor),
    ]);
  } else {
    const chunks: number[][] = [];
    for (let index = 0; index < selectedUserIds.length; index += D1_IN_LIST_CHUNK_SIZE) {
      chunks.push(selectedUserIds.slice(index, index + D1_IN_LIST_CHUNK_SIZE));
    }
    const [counts, pages] = await Promise.all([
      Promise.all(chunks.map((chunk) => prisma.outOfOfficeEntry.count({ where: whereFor(chunk) }))),
      // The keyset cursor spans the whole list, so the chunks are merged in `start` order before the page is cut.
      Promise.all(chunks.map((chunk) => fetchEntries(chunk))),
    ]);
    getTotalEntries = counts.reduce((sum, count) => sum + count, 0);
    const merged = pages
      .flat()
      .sort((left, right) => left.start.getTime() - right.start.getTime() || left.id - right.id);
    const cursorIndex = cursor ? merged.findIndex((entry) => entry.id === cursor) : -1;
    const page = cursor ? (cursorIndex === -1 ? [] : merged.slice(cursorIndex + 1)) : merged;
    outOfOfficeEntries = page.slice(0, limit + 1);
  }

  let nextCursor: number | undefined;
  if (outOfOfficeEntries && outOfOfficeEntries.length > limit) {
    const nextItem = outOfOfficeEntries.pop();
    nextCursor = nextItem?.id;
  }

  return {
    rows:
      outOfOfficeEntries.map((ooo) => {
        return {
          ...ooo,
          canEditAndDelete: fetchTeamMembersEntries ? reportingUserIds.includes(ooo.user.id) : true,
        };
      }) || [],
    nextCursor,
    meta: {
      totalRowCount: getTotalEntries || 0,
    },
  };
};
