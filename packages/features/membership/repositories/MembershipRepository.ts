import { LookupTarget, ProfileRepository } from "@calcom/features/profile/repositories/ProfileRepository";
import { withSelectedCalendars } from "@calcom/features/users/repositories/UserRepository";
import { parseUserAvailability } from "@calcom/lib/availability/parseAvailability";
import logger from "@calcom/lib/logger";
import { findSearchedRows, type KeysetPage } from "@calcom/lib/postgres-ilike";
import { safeStringify } from "@calcom/lib/safeStringify";
import { eventTypeSelect, parseInstantMeetingParameters } from "@calcom/lib/server/eventTypeSelect";
import { availabilityUserSelect, type PrismaTransaction, prisma } from "@calcom/prisma";
import type { Membership, Prisma, PrismaClient } from "@calcom/prisma/client";
import { D1_IN_LIST_CHUNK_SIZE, findManyInChunks } from "@calcom/prisma/d1";
import { MembershipRole } from "@calcom/prisma/enums";
import { credentialForCalendarServiceSelect } from "@calcom/prisma/selects/credential";

const log = logger.getSubLogger({ prefix: ["features/membership/repositories/MembershipRepository"] });
type IMembership = {
  teamId: number;
  userId: number;
  accepted: boolean;
  role: MembershipRole;
  createdAt?: Date;
};

const membershipSelect = {
  id: true,
  teamId: true,
  userId: true,
  accepted: true,
  role: true,
} satisfies Prisma.MembershipSelect;

type MembershipSelectableKeys = keyof typeof membershipSelect;

type MembershipPartialSelect = Partial<Record<MembershipSelectableKeys, boolean>>;

type MembershipDTO = Pick<Membership, MembershipSelectableKeys>;

type MembershipDTOFromSelect<TSelect extends MembershipPartialSelect> = {
  [K in keyof TSelect & keyof MembershipDTO as TSelect[K] extends true ? K : never]: MembershipDTO[K];
};

// Keeps one ascending keyset page exact when the `in` list is too long for a single D1 statement: each chunk
// returns its own first `take` rows, and the merged rows are the same first `take` rows the whole list returns.
async function findIdPage<Row>(
  ids: number[],
  fetchChunk: (chunk: number[]) => Promise<Row[]>,
  take: number,
  getKey: (row: Row) => number
): Promise<Row[]> {
  const unique = Array.from(new Set(ids));
  const chunks: number[][] = [];
  for (let index = 0; index < unique.length; index += D1_IN_LIST_CHUNK_SIZE) {
    chunks.push(unique.slice(index, index + D1_IN_LIST_CHUNK_SIZE));
  }
  const rows = (await Promise.all(chunks.map(fetchChunk))).flat();
  return rows.sort((left, right) => getKey(left) - getKey(right)).slice(0, take);
}

const teamParentSelect = {
  id: true,
  name: true,
  slug: true,
  logoUrl: true,
  parentId: true,
  metadata: true,
} satisfies Prisma.TeamSelect;

const userSelect = {
  name: true,
  avatarUrl: true,
  username: true,
  id: true,
  timeZone: true,
} satisfies Prisma.UserSelect;

const getWhereForfindAllByUpId = async (upId: string, where?: Prisma.MembershipWhereInput) => {
  const lookupTarget = ProfileRepository.getLookupTarget(upId);
  let prismaWhere;
  if (lookupTarget.type === LookupTarget.Profile) {
    /**
     * TODO: When we add profileId to membership, we lookup by profileId
     * If the profile is movedFromUser, we lookup all memberships without profileId as well.
     */
    let profile;
    if ("uid" in lookupTarget && lookupTarget.uid) {
      profile = await ProfileRepository.findByUid(lookupTarget.uid);
    } else if ("id" in lookupTarget && lookupTarget.id !== undefined) {
      profile = await ProfileRepository.findById(lookupTarget.id);
    } else {
      return [];
    }
    if (!profile) {
      return [];
    }
    const userId = "user" in profile && profile.user ? profile.user.id : null;
    if (!userId) {
      return [];
    }
    prismaWhere = {
      userId,
      ...where,
    };
  } else {
    prismaWhere = {
      userId: lookupTarget.id,
      ...where,
    };
  }

  return prismaWhere;
};

export class MembershipRepository {
  constructor(private readonly prismaClient: PrismaClient = prisma) {}

  async hasMembership({ userId, teamId }: { userId: number; teamId: number }): Promise<boolean> {
    const membership = await this.prismaClient.membership.findFirst({
      where: {
        userId,
        teamId,
        accepted: true,
      },
      select: {
        id: true,
      },
    });
    return !!membership;
  }

  async listAcceptedTeamMemberIds({ teamId }: { teamId: number }): Promise<number[]> {
    const memberships =
      (await this.prismaClient.membership.findMany({
        where: {
          teamId,
          accepted: true,
        },
        select: {
          userId: true,
        },
      })) || [];
    const teamMemberIds = memberships.map((membership) => membership.userId);
    return teamMemberIds;
  }

  static async create(data: IMembership) {
    return await prisma.membership.create({
      data: {
        createdAt: new Date(),
        ...data,
      },
    });
  }

  static async hasAnyAcceptedMembershipByUserId(userId: number) {
    const membership = await prisma.membership.findFirst({
      where: {
        accepted: true,
        userId,
        team: {
          slug: {
            not: null,
          },
        },
      },
      select: { id: true },
    });
    return Boolean(membership);
  }

  static async findAcceptedMembershipsByUserIdsInTeam({
    userIds,
    teamId,
  }: {
    userIds: number[];
    teamId: number;
  }) {
    return findManyInChunks(userIds, (chunk) =>
      prisma.membership.findMany({
        where: {
          userId: { in: chunk },
          accepted: true,
          teamId,
        },
      })
    );
  }

  static async createMany(data: IMembership[]) {
    return await prisma.membership.createMany({
      data: data.map((item) => ({
        createdAt: new Date(),
        ...item,
      })),
    });
  }

  /**
   * TODO: Using a specific function for specific tasks so that we don't have to focus on TS magic at the moment. May be try to make it a a generic findAllByProfileId with various options.
   */
  static async findAllByUpIdIncludeTeamWithMembersAndEventTypes(
    { upId }: { upId: string },
    { where }: { where?: Prisma.MembershipWhereInput } = {}
  ) {
    const prismaWhere = await getWhereForfindAllByUpId(upId, where);
    if (Array.isArray(prismaWhere)) {
      return prismaWhere;
    }

    log.debug(
      "findAllByUpIdIncludeTeamWithMembersAndEventTypes",
      safeStringify({
        prismaWhere,
      })
    );

    const memberships = await prisma.membership.findMany({
      where: prismaWhere,
      include: {
        team: {
          include: {
            members: {
              select: membershipSelect,
            },
            parent: {
              select: teamParentSelect,
            },
            eventTypes: {
              select: {
                ...eventTypeSelect,
                hashedLink: true,
                users: { select: userSelect },
                children: {
                  include: {
                    users: { select: userSelect },
                  },
                },
                hosts: {
                  include: {
                    user: { select: userSelect },
                  },
                },
                team: {
                  select: {
                    id: true,
                    members: {
                      select: {
                        user: {
                          select: {
                            timeZone: true,
                          },
                        },
                      },
                      take: 1,
                    },
                  },
                },
              },
              // As required by getByViewHandler - Make it configurable
              orderBy: [
                {
                  position: "desc",
                },
                {
                  id: "asc",
                },
              ],
            },
          },
        },
      },
    });
    return memberships.map((membership) => ({
      ...membership,
      team: {
        ...membership.team,
        eventTypes: membership.team.eventTypes.map((eventType) => ({
          ...parseInstantMeetingParameters(eventType),
          children: eventType.children.map(parseInstantMeetingParameters),
        })),
      },
    }));
  }

  static async findAllByUpIdIncludeMinimalEventTypes(
    { upId }: { upId: string },
    { where, skipEventTypes = false }: { where?: Prisma.MembershipWhereInput; skipEventTypes?: boolean } = {}
  ) {
    const prismaWhere = await getWhereForfindAllByUpId(upId, where);
    if (Array.isArray(prismaWhere)) {
      return prismaWhere;
    }

    log.debug(
      "findAllByUpIdIncludeMinimalEventTypes",
      safeStringify({
        prismaWhere,
      })
    );

    const select = {
      id: true,
      teamId: true,
      userId: true,
      accepted: true,
      role: true,
      team: {
        select: {
          ...teamParentSelect,
          isOrganization: true,
          parent: {
            select: teamParentSelect,
          },
          ...(!skipEventTypes
            ? {
                eventTypes: {
                  select: {
                    ...eventTypeSelect,
                    hashedLink: true,
                    children: { select: { id: true } },
                  },
                  orderBy: [
                    {
                      position: "desc",
                    },
                    {
                      id: "asc",
                    },
                  ],
                },
              }
            : {}),
        },
      },
    } satisfies Prisma.MembershipSelect;

    const memberships = await prisma.membership.findMany({
      where: prismaWhere,
      select,
    });
    return memberships.map((membership) => {
      const { eventTypes, ...team } = membership.team;
      return {
        ...membership,
        team: {
          ...team,
          ...(eventTypes ? { eventTypes: eventTypes.map(parseInstantMeetingParameters) } : {}),
        },
      };
    });
  }

  static async findAllByUpIdIncludeTeam(
    { upId }: { upId: string },
    { where }: { where?: Prisma.MembershipWhereInput } = {}
  ) {
    const prismaWhere = await getWhereForfindAllByUpId(upId, where);
    if (Array.isArray(prismaWhere)) {
      return prismaWhere;
    }

    return await prisma.membership.findMany({
      where: prismaWhere,
      include: {
        team: {
          include: {
            parent: {
              select: teamParentSelect,
            },
          },
        },
      },
    });
  }

  async findUniqueByUserIdAndTeamId({ userId, teamId }: { userId: number; teamId: number }) {
    return await this.prismaClient.membership.findUnique({
      where: {
        userId_teamId: {
          userId,
          teamId,
        },
      },
    });
  }

  async findRoleByUserIdAndTeamId({ userId, teamId }: { userId: number; teamId: number }) {
    return await this.prismaClient.membership.findUnique({
      where: {
        userId_teamId: {
          userId,
          teamId,
        },
      },
      select: {
        role: true,
      },
    });
  }

  async findMembershipsWithUserByTeamId({ teamId }: { teamId: number }) {
    return this.prismaClient.membership.findMany({
      where: { teamId },
      select: {
        role: true,
        accepted: true,
        user: {
          select: {
            name: true,
            avatarUrl: true,
            username: true,
            id: true,
            email: true,
            locale: true,
            defaultScheduleId: true,
            isPlatformManaged: true,
            timeZone: true,
            eventTypes: {
              select: {
                slug: true,
              },
            },
          },
        },
      },
    });
  }

  async findAllMembershipsByUserIdForBilling({ userId }: { userId: number }) {
    return this.prismaClient.membership.findMany({
      where: { userId },
      select: {
        accepted: true,
        user: {
          select: {
            isPlatformManaged: true,
          },
        },
        team: {
          select: {
            slug: true,
            isOrganization: true,
            isPlatform: true,
            metadata: true,
            platformBilling: {
              select: {
                plan: true,
              },
            },
            parent: {
              select: {
                isOrganization: true,
                slug: true,
                metadata: true,
                isPlatform: true,
              },
            },
          },
        },
      },
    });
  }

  static async findByTeamIdForAvailability({ teamId }: { teamId: number }) {
    const memberships = await prisma.membership.findMany({
      where: { teamId },
      include: {
        user: {
          select: {
            credentials: {
              select: credentialForCalendarServiceSelect,
            }, // needed for getUserAvailability
            ...availabilityUserSelect,
          },
        },
      },
    });

    const membershipsWithSelectedCalendars = memberships.map((m) => {
      return {
        ...m,
        user: withSelectedCalendars(parseUserAvailability(m.user)),
      };
    });

    return membershipsWithSelectedCalendars;
  }

  static async getAdminOrOwnerMembership(userId: number, teamId: number) {
    return prisma.membership.findFirst({
      where: {
        userId,
        teamId,
        accepted: true,
        role: {
          in: [MembershipRole.ADMIN, MembershipRole.OWNER],
        },
      },
      select: {
        id: true,
      },
    });
  }

  static async findAllAcceptedPublishedTeamMemberships(userId: number, tx?: PrismaTransaction) {
    return (tx ?? prisma).membership.findMany({
      where: {
        userId,
        accepted: true,
        team: {
          slug: { not: null },
        },
      },
      select: {
        teamId: true,
      },
    });
  }

  /**
   * Get all team IDs that a user is a member of
   */
  static async findUserTeamIds({ userId }: { userId: number }) {
    const memberships = await prisma.membership.findMany({
      where: {
        userId,
        accepted: true,
      },
      select: {
        teamId: true,
      },
    });

    return memberships.map((membership) => membership.teamId);
  }

  /**
   * Returns members who joined after the given time
   */
  static async findMembershipsCreatedAfterTimeIncludeUser({
    organizationId,
    time,
  }: {
    organizationId: number;
    time: Date;
  }) {
    return prisma.membership.findMany({
      where: {
        teamId: organizationId,
        createdAt: { gt: time },
        accepted: true,
      },
      include: {
        user: {
          select: {
            email: true,
            name: true,
            id: true,
          },
        },
      },
    });
  }

  static async findAllByTeamIds<TSelect extends MembershipPartialSelect = { userId: true }>({
    teamIds,
    select,
  }: {
    teamIds: number[];
    select?: TSelect;
  }): Promise<MembershipDTOFromSelect<TSelect>[]> {
    return (await findManyInChunks(teamIds, (chunk) =>
      prisma.membership.findMany({
        where: {
          teamId: { in: chunk },
          accepted: true,
        },
        // this is explicit, and typed in TSelect default typings
        select: select ?? { userId: true },
      })
    )) as unknown as MembershipDTOFromSelect<TSelect>[];
  }

  static async findAllAcceptedTeamMemberships(userId: number, where?: Prisma.MembershipWhereInput) {
    const teams = await prisma.team.findMany({
      where: {
        members: {
          some: {
            userId,
            accepted: true,
            ...(where ?? {}),
          },
        },
      },
    });
    return teams;
  }

  async findAllByUserId({
    userId,
    filters,
  }: {
    userId: number;
    filters?: {
      accepted?: boolean;
      roles?: MembershipRole[];
    };
  }) {
    return this.prismaClient.membership.findMany({
      where: {
        userId,
        ...(filters?.accepted !== undefined && { accepted: filters.accepted }),
        ...(filters?.roles && { role: { in: filters.roles } }),
      },
      select: {
        teamId: true,
        role: true,
        team: {
          select: {
            id: true,
            parentId: true,
            isOrganization: true,
          },
        },
      },
    });
  }

  async findTeamAdminsByTeamId({ teamId }: { teamId: number }) {
    return await this.prismaClient.membership.findMany({
      where: {
        team: {
          id: teamId,
          parentId: {
            not: null,
          },
        },
        role: {
          in: ["ADMIN", "OWNER"],
        },
      },
      select: {
        user: {
          select: {
            email: true,
            locale: true,
          },
        },
      },
    });
  }

  // Two indexed lookups instead of JOIN with ILIKE (which bypasses index)
  async hasAcceptedMembershipByEmail({ email, teamId }: { email: string; teamId: number }): Promise<boolean> {
    const user = await this.prismaClient.user.findUnique({
      where: { email: email.toLowerCase() },
      select: { id: true },
    });

    if (!user) return false;

    const membership = await this.prismaClient.membership.findUnique({
      where: {
        userId_teamId: { userId: user.id, teamId },
      },
      select: { accepted: true },
    });

    return membership?.accepted ?? false;
  }

  static async hasPendingInviteByUserId({ userId }: { userId: number }): Promise<boolean> {
    const pendingInvite = await prisma.membership.findFirst({
      where: {
        userId,
        accepted: false,
      },
      select: {
        id: true,
      },
    });
    return !!pendingInvite;
  }

  async searchMembers({
    teamId,
    search,
    cursor,
    limit,
    memberUserIds,
  }: {
    teamId: number;
    search?: string | null;
    cursor?: number | null;
    limit: number;
    memberUserIds?: number[] | null;
  }) {
    const memberships = await findSearchedRows({
      search: search ?? undefined,
      cursor: cursor ?? undefined,
      limit,
      getKey: (membership) => membership.user.id,
      getSearchValues: ({ user }) => [user.name, user.email],
      fetchRows: ({ after, take }: KeysetPage) => {
        const fetchPage = (memberIds?: number[]) => {
          const userIdFilter = memberIds
            ? after
              ? { in: memberIds, gt: after }
              : { in: memberIds }
            : after
              ? { gt: after }
              : undefined;

          return this.prismaClient.membership.findMany({
            where: {
              teamId,
              accepted: true,
              ...(userIdFilter && { user: { id: userIdFilter } }),
            },
            take,
            orderBy: { user: { id: "asc" } },
            select: {
              user: {
                select: {
                  id: true,
                  name: true,
                  email: true,
                  avatarUrl: true,
                  username: true,
                  defaultScheduleId: true,
                },
              },
              role: true,
            },
          });
        };

        if (memberUserIds === undefined || memberUserIds === null) return fetchPage();

        return findIdPage(memberUserIds, fetchPage, take, (row) => row.user.id);
      },
    });

    const hasMore = memberships.length > limit;
    const items = hasMore ? memberships.slice(0, limit) : memberships;
    const nextCursor = hasMore ? items[items.length - 1].user.id : undefined;

    return { memberships: items, nextCursor, hasMore };
  }

  async findAcceptedMembersWithUserProfile({ teamId }: { teamId: number }) {
    return this.prismaClient.membership.findMany({
      where: {
        teamId,
        accepted: true,
      },
      orderBy: { user: { id: "asc" } },
      select: {
        user: {
          select: {
            id: true,
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
    });
  }

  /**
   * Checks if a user has any team membership (pending or accepted).
   * Used during onboarding to detect users who signed up via invite token,
   * where the membership is auto-accepted.
   */
  static async hasAnyTeamMembershipByUserId({ userId }: { userId: number }): Promise<boolean> {
    const membership = await prisma.membership.findFirst({
      where: {
        userId,
        team: {
          isOrganization: false,
        },
      },
      select: {
        id: true,
      },
    });
    return !!membership;
  }
}
