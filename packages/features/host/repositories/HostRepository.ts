import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { z } from "zod";

const booleanSchema = z.union([z.literal(0), z.literal(1)]).transform(Boolean);
const conferencingPredicate = `EXISTS (SELECT 1 FROM json_each(a."categories") WHERE value IN ('conferencing', 'video'))`;
const hostLocationColumns = `h."userId", h."isFixed", h."priority", u."name", u."email", u."avatarUrl", u."metadata",
  CASE WHEN l."id" IS NULL THEN NULL ELSE json_object('id', l."id", 'type', l."type", 'credentialId', l."credentialId",
    'link', l."link", 'address', l."address", 'phoneNumber', l."phoneNumber") END AS "location",
  (SELECT json_group_array(json_object('id', c."id", 'type', c."type", 'userId', c."userId", 'teamId', c."teamId",
    'appId', c."appId", 'invalid', c."invalid", 'delegationCredentialId', c."delegationCredentialId",
    'user', json_object('email', u."email"))) FROM "Credential" c JOIN "App" a ON a."slug" = c."appId"
    WHERE c."userId" = h."userId" AND ${conferencingPredicate}) AS "credentials"`;
const hostLocationJoins = `FROM "Host" h JOIN "users" u ON u."id" = h."userId"
  LEFT JOIN "HostLocation" l ON l."userId" = h."userId" AND l."eventTypeId" = h."eventTypeId"`;
const hostLocationSchema = z.object({
  userId: z.number(),
  isFixed: booleanSchema,
  priority: z.number().nullable(),
  name: z.string().nullable(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
  metadata: z
    .string()
    .nullable()
    .transform((value): Prisma.JsonValue => (value === null ? null : JSON.parse(value))),
  location: z
    .string()
    .nullable()
    .transform((value) =>
      value === null
        ? null
        : z
            .object({
              id: z.string(),
              type: z.string(),
              credentialId: z.number().nullable(),
              link: z.string().nullable(),
              address: z.string().nullable(),
              phoneNumber: z.string().nullable(),
            })
            .parse(JSON.parse(value))
    ),
  credentials: z.string().transform((value) =>
    z
      .object({
        id: z.number(),
        type: z.string(),
        userId: z.number().nullable(),
        teamId: z.number().nullable(),
        appId: z.string().nullable(),
        invalid: booleanSchema.nullable(),
        delegationCredentialId: z.string().nullable(),
        user: z.object({ email: z.string() }).nullable(),
      })
      .array()
      .parse(JSON.parse(value))
  ),
});
function parseHostsWithLocationOptions(rows: unknown) {
  return hostLocationSchema
    .array()
    .parse(rows)
    .map(({ userId, isFixed, priority, location, ...user }) => ({
      userId,
      isFixed,
      priority,
      location,
      user: { id: userId, ...user },
    }));
}

export class HostRepository {
  constructor(private prismaClient: PrismaClient) {}

  async updateHostsSchedule(userId: number, oldScheduleId: number, newScheduleId: number) {
    return await this.prismaClient.host.updateMany({
      where: {
        userId,
        scheduleId: oldScheduleId,
      },
      data: {
        scheduleId: newScheduleId,
      },
    });
  }

  async findHostsCreatedInInterval({
    eventTypeId,
    userIds,
    startDate,
  }: {
    eventTypeId: number;
    userIds: number[];
    startDate: Date;
  }) {
    return await this.prismaClient.host.findMany({
      where: {
        userId: {
          in: userIds,
        },
        eventTypeId,
        isFixed: false,
        createdAt: {
          gte: startDate,
        },
      },
    });
  }

  async findHostsWithLocationOptions(eventTypeId: number) {
    const { results } = await getD1Database()
      .prepare(`SELECT ${hostLocationColumns} ${hostLocationJoins}
      WHERE h."eventTypeId" = ? ORDER BY u."name" ASC NULLS LAST, h."priority" DESC NULLS FIRST`)
      .bind(eventTypeId)
      .all();
    return parseHostsWithLocationOptions(results);
  }

  async findHostsWithLocationOptionsPaginated({
    eventTypeId,
    cursor,
    limit = 10,
  }: {
    eventTypeId: number;
    cursor?: number;
    limit?: number;
  }) {
    const { results } = await getD1Database()
      .prepare(`SELECT ${hostLocationColumns} ${hostLocationJoins}
      WHERE h."eventTypeId" = ? AND (? IS NULL OR h."userId" > ?) ORDER BY h."userId" ASC LIMIT ?`)
      .bind(eventTypeId, cursor || null, cursor || null, limit + 1)
      .all();
    const hosts = parseHostsWithLocationOptions(results);

    const hasMore = hosts.length > limit;
    const items = hasMore ? hosts.slice(0, limit) : hosts;
    const nextCursor = hasMore ? items[items.length - 1].userId : undefined;

    return { items, nextCursor, hasMore };
  }

  async findHostsPaginatedIncludeUser({
    eventTypeId,
    cursor,
    limit = 20,
    search,
  }: {
    eventTypeId: number;
    cursor?: number;
    limit?: number;
    search?: string;
  }) {
    const hosts = await this.prismaClient.host.findMany({
      where: {
        eventTypeId,
        ...(cursor && { userId: { gt: cursor } }),
        ...(search && {
          OR: [
            { user: { name: { contains: search, mode: "insensitive" as const } } },
            { user: { email: { contains: search, mode: "insensitive" as const } } },
          ],
        }),
      },
      take: limit + 1,
      select: {
        userId: true,
        isFixed: true,
        priority: true,
        weight: true,
        scheduleId: true,
        groupId: true,
        user: {
          select: {
            name: true,
            avatarUrl: true,
            timeZone: true,
          },
        },
      },
      orderBy: [{ userId: "asc" }],
    });

    const hasMore = hosts.length > limit;
    const items = hasMore ? hosts.slice(0, limit) : hosts;
    const nextCursor = hasMore ? items[items.length - 1].userId : undefined;

    return { items, nextCursor, hasMore };
  }

  async findHostsPaginatedIncludeUserForAssignment({
    eventTypeId,
    cursor,
    limit = 20,
    search,
    memberUserIds,
  }: {
    eventTypeId: number;
    cursor?: number;
    limit?: number;
    search?: string;
    memberUserIds?: number[];
  }) {
    const userIdFilter =
      memberUserIds !== undefined
        ? cursor
          ? { in: memberUserIds, gt: cursor }
          : { in: memberUserIds }
        : cursor
          ? { gt: cursor }
          : undefined;

    const hosts = await this.prismaClient.host.findMany({
      where: {
        eventTypeId,
        ...(userIdFilter && { userId: userIdFilter }),
        ...(search && {
          OR: [
            { user: { name: { contains: search, mode: "insensitive" as const } } },
            { user: { email: { contains: search, mode: "insensitive" as const } } },
          ],
        }),
      },
      take: limit + 1,
      select: {
        userId: true,
        isFixed: true,
        priority: true,
        weight: true,
        scheduleId: true,
        groupId: true,
        user: {
          select: {
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [{ userId: "asc" }],
    });

    const hasMore = hosts.length > limit;
    const items = hasMore ? hosts.slice(0, limit) : hosts;
    const nextCursor = hasMore ? items[items.length - 1].userId : undefined;

    // Only check on the first page to avoid an extra query on every scroll
    const hasFixedHosts = !cursor
      ? (await this.prismaClient.host.count({
          where: { eventTypeId, isFixed: true },
          take: 1,
        })) > 0
      : undefined;

    return { items, nextCursor, hasMore, hasFixedHosts };
  }

  async findAllRoundRobinHosts({ eventTypeId }: { eventTypeId: number }) {
    return this.prismaClient.host.findMany({
      where: {
        eventTypeId,
        isFixed: false,
      },
      select: {
        userId: true,
        weight: true,
        user: {
          select: {
            name: true,
            email: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [{ userId: "asc" }],
    });
  }

  async findChildrenForAssignmentPaginated({
    eventTypeId,
    cursor,
    limit = 20,
    search,
  }: {
    eventTypeId: number;
    cursor?: number;
    limit?: number;
    search?: string;
  }) {
    const children = await this.prismaClient.eventType.findMany({
      where: {
        parentId: eventTypeId,
        ...(cursor && { id: { gt: cursor } }),
        ...(search && {
          OR: [
            { owner: { name: { contains: search, mode: "insensitive" as const } } },
            { owner: { email: { contains: search, mode: "insensitive" as const } } },
          ],
        }),
      },
      take: limit + 1,
      select: {
        id: true,
        slug: true,
        hidden: true,
        owner: {
          select: {
            id: true,
            name: true,
            email: true,
            username: true,
            avatarUrl: true,
          },
        },
      },
      orderBy: [{ id: "asc" }],
    });

    const hasMore = children.length > limit;
    const items = hasMore ? children.slice(0, limit) : children;
    const nextCursor = hasMore ? items[items.length - 1].id : undefined;

    return { items, nextCursor, hasMore };
  }

  async findHostsWithConferencingCredentials(eventTypeId: number) {
    const { results } = await getD1Database()
      .prepare(`SELECT h."userId",
      (SELECT json_group_array(json_object('id', c."id", 'type', c."type", 'appId', c."appId"))
        FROM "Credential" c JOIN "App" a ON a."slug" = c."appId"
        WHERE c."userId" = h."userId" AND ${conferencingPredicate}) AS "credentials"
      FROM "Host" h WHERE h."eventTypeId" = ?`)
      .bind(eventTypeId)
      .all();
    return z
      .object({
        userId: z.number(),
        credentials: z
          .string()
          .transform((value) =>
            z
              .object({ id: z.number(), type: z.string(), appId: z.string().nullable() })
              .array()
              .parse(JSON.parse(value))
          ),
      })
      .array()
      .parse(results)
      .map(({ userId, credentials }) => ({ userId, user: { credentials } }));
  }
}
