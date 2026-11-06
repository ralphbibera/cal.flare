import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { D1_IN_LIST_CHUNK_SIZE } from "@calcom/prisma/d1";
import type { WrongAssignmentReportStatus } from "@calcom/prisma/enums";

const reportSelect = {
  id: true,
  bookingUid: true,
  correctAssignee: true,
  additionalNotes: true,
  status: true,
  createdAt: true,
  reviewedAt: true,
  booking: {
    select: {
      id: true,
      title: true,
      startTime: true,
      endTime: true,
      user: {
        select: {
          id: true,
          name: true,
          email: true,
        },
      },
      attendees: {
        select: {
          name: true,
          email: true,
        },
      },
    },
  },
  reportedBy: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
  reviewedBy: {
    select: {
      id: true,
      name: true,
      email: true,
    },
  },
} satisfies Prisma.WrongAssignmentReportSelect;

export class WrongAssignmentReportRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  async existsByBookingUid(bookingUid: string): Promise<boolean> {
    const report = await this.prismaClient.wrongAssignmentReport.findUnique({
      where: { bookingUid },
      select: { id: true },
    });
    return !!report;
  }

  async createReport(input: {
    bookingUid: string;
    reportedById: number;
    correctAssignee: string | null;
    additionalNotes: string;
    teamId: number | null;
  }): Promise<{ id: string }> {
    return this.prismaClient.wrongAssignmentReport.create({
      data: input,
      select: { id: true },
    });
  }

  async findTeamIdById(id: string): Promise<{ id: string; teamId: number | null } | null> {
    return this.prismaClient.wrongAssignmentReport.findUnique({
      where: { id },
      select: {
        id: true,
        teamId: true,
      },
    });
  }

  async findByTeamIdsAndStatuses({
    teamIds,
    statuses,
    reportedById,
    limit,
    offset,
  }: {
    teamIds: number[];
    statuses: WrongAssignmentReportStatus[];
    reportedById?: number;
    limit: number;
    offset: number;
  }) {
    const uniqueTeamIds = Array.from(new Set(teamIds));
    const whereFor = (chunk: number[]) => {
      const where: {
        teamId: { in: number[] };
        status: { in: WrongAssignmentReportStatus[] };
        reportedById?: number;
      } = { teamId: { in: chunk }, status: { in: statuses } };
      if (reportedById) where.reportedById = reportedById;
      return where;
    };

    if (uniqueTeamIds.length > D1_IN_LIST_CHUNK_SIZE) {
      const chunks: number[][] = [];
      for (let index = 0; index < uniqueTeamIds.length; index += D1_IN_LIST_CHUNK_SIZE) {
        chunks.push(uniqueTeamIds.slice(index, index + D1_IN_LIST_CHUNK_SIZE));
      }
      const [pages, counts] = await Promise.all([
        Promise.all(
          chunks.map((chunk) =>
            this.prismaClient.wrongAssignmentReport.findMany({
              where: whereFor(chunk),
              select: reportSelect,
              orderBy: { createdAt: "desc" },
              // Each chunk's first offset + limit rows contain the global page after the merge below.
              take: offset + limit,
            })
          )
        ),
        Promise.all(
          chunks.map((chunk) => this.prismaClient.wrongAssignmentReport.count({ where: whereFor(chunk) }))
        ),
      ]);
      const reports = pages
        .flat()
        .sort(
          (left, right) =>
            right.createdAt.getTime() - left.createdAt.getTime() || right.id.localeCompare(left.id)
        )
        .slice(offset, offset + limit);
      return { reports, totalCount: counts.reduce((sum, count) => sum + count, 0) };
    }

    const [reports, totalCount] = await Promise.all([
      this.prismaClient.wrongAssignmentReport.findMany({
        where: whereFor(uniqueTeamIds),
        select: reportSelect,
        orderBy: { createdAt: "desc" },
        take: limit,
        skip: offset,
      }),
      this.prismaClient.wrongAssignmentReport.count({ where: whereFor(uniqueTeamIds) }),
    ]);

    return { reports, totalCount };
  }

  async updateStatus({
    id,
    status,
    reviewedById,
  }: {
    id: string;
    status: WrongAssignmentReportStatus;
    reviewedById: number;
  }) {
    return this.prismaClient.wrongAssignmentReport.update({
      where: { id },
      data: {
        status,
        reviewedById: status === "PENDING" ? null : reviewedById,
        reviewedAt: status === "PENDING" ? null : new Date(),
      },
      select: {
        id: true,
        status: true,
        reviewedById: true,
        reviewedAt: true,
      },
    });
  }
}
