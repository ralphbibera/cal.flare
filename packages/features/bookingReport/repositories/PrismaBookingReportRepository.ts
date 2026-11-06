import type { KeysetPage } from "@calcom/lib/keyset-scan";
import { findMatchingKeysetRows } from "@calcom/lib/keyset-scan";
import { createContainsInsensitiveMatcher, createIlikeMatcher } from "@calcom/lib/postgres-ilike";
import type { PrismaClient } from "@calcom/prisma";
import { getD1Database } from "@calcom/prisma/d1";
import type { BookingReportStatus, SystemReportStatus } from "@calcom/prisma/enums";
import type { Prisma } from "@calcom/prisma/generated/prisma/client";
import type {
  BookingReportWithDetails,
  CreateBookingReportInput,
  GroupedBookingReportWithDetails,
  IBookingReportRepository,
  ListBookingReportsFilters,
  SystemBookingReportsFilters,
} from "./IBookingReportRepository";

const serializeDate = (value: Date) => value.toISOString().replace("Z", "+00:00");

export class PrismaBookingReportRepository implements IBookingReportRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  private buildWhereClause(params: {
    organizationId?: number;
    filters?: ListBookingReportsFilters;
    systemFilters?: SystemBookingReportsFilters;
  }): Prisma.BookingReportWhereInput {
    const where: Prisma.BookingReportWhereInput = {};

    if (params.organizationId) {
      where.organizationId = params.organizationId;
    }

    if (params.filters?.hasWatchlist !== undefined) {
      where.watchlistId = params.filters.hasWatchlist ? { not: null } : null;
    }

    if (params.filters?.reason && params.filters.reason.length > 0) {
      where.reason = { in: params.filters.reason };
    }

    if (params.filters?.cancelled !== undefined) {
      where.cancelled = params.filters.cancelled;
    }

    if (params.filters?.status && params.filters.status.length > 0) {
      where.status = { in: params.filters.status };
    }

    if (params.systemFilters?.systemStatus && params.systemFilters.systemStatus.length > 0) {
      where.systemStatus = { in: params.systemFilters.systemStatus };
    }

    return where;
  }

  private readonly reportSelect = {
    id: true,
    bookingUid: true,
    bookerEmail: true,
    reportedById: true,
    reason: true,
    description: true,
    cancelled: true,
    createdAt: true,
    status: true,
    systemStatus: true,
    watchlistId: true,
    globalWatchlistId: true,
    organizationId: true,
    reportedBy: { select: { id: true, email: true, name: true } },
    booking: { select: { id: true, uid: true, title: true, startTime: true, endTime: true } },
    watchlist: { select: { id: true, type: true, value: true, action: true, description: true } },
    globalWatchlist: { select: { id: true, type: true, value: true, action: true, description: true } },
    organization: { select: { id: true, name: true, slug: true } },
  } as const;

  // SQLite only folds ASCII, so insensitive filters match in memory, walking the scoped rows by id.
  private async findReportsMatchingSearch(where: Prisma.BookingReportWhereInput, searchTerm: string) {
    const matches = createContainsInsensitiveMatcher(searchTerm);
    const reports = await findMatchingKeysetRows({
      getKey: (report) => report.id,
      matches: (report) => matches(report.bookerEmail) || matches(report.reportedBy?.email),
      fetchRows: ({ after, take }: KeysetPage<string>) =>
        this.prismaClient.bookingReport.findMany({
          where: { ...where, ...(after && { id: { gt: after } }) },
          take,
          orderBy: { id: "asc" },
          select: this.reportSelect,
        }),
    });
    return reports.map((report) => ({ ...report, reporter: report.reportedBy }));
  }

  private findPendingReports(emailPattern: string, organizationId: number) {
    const matches = createIlikeMatcher(emailPattern);
    return findMatchingKeysetRows({
      getKey: (report) => report.id,
      matches: (report) => matches(report.bookerEmail),
      fetchRows: ({ after, take }: KeysetPage<string>) =>
        this.prismaClient.bookingReport.findMany({
          where: {
            status: "PENDING",
            watchlistId: null,
            organizationId,
            ...(after && { id: { gt: after } }),
          },
          take,
          orderBy: { id: "asc" },
          select: { id: true, bookerEmail: true, watchlistId: true },
        }),
    });
  }

  private findPendingSystemReports(emailPattern: string) {
    const matches = createIlikeMatcher(emailPattern);
    return findMatchingKeysetRows({
      getKey: (report) => report.id,
      matches: (report) => matches(report.bookerEmail),
      fetchRows: ({ after, take }: KeysetPage<string>) =>
        this.prismaClient.bookingReport.findMany({
          where: { systemStatus: "PENDING", globalWatchlistId: null, ...(after && { id: { gt: after } }) },
          take,
          orderBy: { id: "asc" },
          select: { id: true, bookerEmail: true, globalWatchlistId: true },
        }),
    });
  }

  async createReport(input: CreateBookingReportInput): Promise<{ id: string }> {
    const report = await this.prismaClient.bookingReport.create({
      data: {
        bookingUid: input.bookingUid,
        bookerEmail: input.bookerEmail,
        reportedById: input.reportedById,
        reason: input.reason,
        description: input.description,
        cancelled: input.cancelled,
        organizationId: input.organizationId,
      },
      select: { id: true },
    });
    return report;
  }

  async findAllReportedBookings(params: {
    organizationId?: number;
    skip?: number;
    take?: number;
    searchTerm?: string;
    filters?: ListBookingReportsFilters;
    systemFilters?: SystemBookingReportsFilters;
  }): Promise<{
    rows: BookingReportWithDetails[];
    meta: { totalRowCount: number };
  }> {
    const where = this.buildWhereClause(params);

    if (params.systemFilters?.systemStatus && params.systemFilters.systemStatus.length > 0) {
      where.systemStatus = { in: params.systemFilters.systemStatus };
    }

    if (params.searchTerm) {
      const matched = await this.findReportsMatchingSearch(where, params.searchTerm);
      matched.sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime() || (a.id < b.id ? -1 : 1));
      const skip = params.skip ?? 0;
      const rows = matched.slice(skip, params.take === undefined ? undefined : skip + params.take);
      return { rows, meta: { totalRowCount: matched.length } };
    }

    const [reports, totalCount] = await Promise.all([
      this.prismaClient.bookingReport.findMany({
        where,
        skip: params.skip,
        take: params.take,
        select: this.reportSelect,
        orderBy: { createdAt: "desc" },
      }),
      this.prismaClient.bookingReport.count({ where }),
    ]);

    const rows = reports.map((report) => ({ ...report, reporter: report.reportedBy }));

    return { rows, meta: { totalRowCount: totalCount } };
  }

  async findGroupedReportedBookings(params: {
    organizationId?: number;
    skip?: number;
    take?: number;
    searchTerm?: string;
    filters?: ListBookingReportsFilters;
    systemFilters?: SystemBookingReportsFilters;
    sortBy?: "createdAt" | "reportCount";
  }): Promise<{
    rows: GroupedBookingReportWithDetails[];
    meta: { totalRowCount: number };
  }> {
    const where = this.buildWhereClause(params);

    if (params.searchTerm) {
      const matched = await this.findReportsMatchingSearch(where, params.searchTerm);
      matched.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const reportsByEmail = new Map<string, BookingReportWithDetails[]>();
      for (const report of matched) {
        const reports = reportsByEmail.get(report.bookerEmail) ?? [];
        reports.push(report);
        reportsByEmail.set(report.bookerEmail, reports);
      }
      const latest = (reports: BookingReportWithDetails[]) => reports[reports.length - 1].createdAt.getTime();
      const groups = Array.from(reportsByEmail.values()).sort(
        (a, b) =>
          (params.sortBy === "reportCount" ? b.length - a.length : latest(b) - latest(a)) ||
          (a[0].bookerEmail < b[0].bookerEmail ? -1 : 1)
      );
      const skip = params.skip ?? 0;
      const rows = groups
        .slice(skip, skip + (params.take ?? 25))
        .map((reports) => ({ ...reports[0], reportCount: reports.length, reports }));
      return { rows, meta: { totalRowCount: groups.length } };
    }

    const orderBy =
      params.sortBy === "reportCount"
        ? { _count: { bookerEmail: "desc" as const } }
        : { _max: { createdAt: "desc" as const } };

    const groupedEmails = await this.prismaClient.bookingReport.groupBy({
      by: ["bookerEmail"],
      where,
      _count: { bookerEmail: true },
      _max: { createdAt: true },
      orderBy,
    });

    const totalRowCount = groupedEmails.length;
    const paginatedEmails = groupedEmails.slice(params.skip ?? 0, (params.skip ?? 0) + (params.take ?? 25));
    const emailList = paginatedEmails.map((g) => g.bookerEmail);

    if (emailList.length === 0) {
      return { rows: [], meta: { totalRowCount } };
    }

    const reports = await this.prismaClient.bookingReport.findMany({
      where: { ...where, bookerEmail: { in: emailList } },
      select: this.reportSelect,
      orderBy: { createdAt: "asc" },
    });

    const reportsByEmail = new Map<string, BookingReportWithDetails[]>();
    for (const report of reports) {
      const mapped: BookingReportWithDetails = { ...report, reporter: report.reportedBy };
      const existing = reportsByEmail.get(report.bookerEmail) || [];
      existing.push(mapped);
      reportsByEmail.set(report.bookerEmail, existing);
    }

    const rows: GroupedBookingReportWithDetails[] = paginatedEmails.map((group) => {
      const emailReports = reportsByEmail.get(group.bookerEmail) || [];
      const firstReport = emailReports[0];
      return { ...firstReport, reportCount: group._count.bookerEmail, reports: emailReports };
    });

    return { rows, meta: { totalRowCount } };
  }

  async findReportsByIds(params: {
    reportIds: string[];
    organizationId?: number;
  }): Promise<BookingReportWithDetails[]> {
    const where: Prisma.BookingReportWhereInput = { id: { in: params.reportIds } };

    if (params.organizationId) {
      where.organizationId = params.organizationId;
    }

    const reports = await this.prismaClient.bookingReport.findMany({
      where,
      select: this.reportSelect,
    });

    return reports.map((report) => ({ ...report, reporter: report.reportedBy }));
  }

  async linkWatchlistToReport(params: { reportId: string; watchlistId: string }): Promise<void> {
    await this.prismaClient.bookingReport.update({
      where: { id: params.reportId },
      data: { watchlistId: params.watchlistId },
    });
  }

  async updateReportStatus(params: {
    reportId: string;
    status: BookingReportStatus;
    organizationId?: number;
  }): Promise<void> {
    const where: Prisma.BookingReportWhereInput = {
      id: params.reportId,
    };

    if (params.organizationId) {
      where.organizationId = params.organizationId;
    }

    await this.prismaClient.bookingReport.updateMany({
      where,
      data: { status: params.status },
    });
  }

  async bulkLinkWatchlistWithStatus(params: {
    links: Array<{ reportId: string; watchlistId: string }>;
    status: BookingReportStatus;
  }): Promise<void> {
    if (params.links.length === 0) return;

    const groupedByWatchlist = new Map<string, string[]>();
    for (const link of params.links) {
      const reportIds = groupedByWatchlist.get(link.watchlistId) || [];
      reportIds.push(link.reportId);
      groupedByWatchlist.set(link.watchlistId, reportIds);
    }

    await Promise.all(
      Array.from(groupedByWatchlist.entries()).map(([watchlistId, reportIds]) =>
        this.prismaClient.bookingReport.updateMany({
          where: { id: { in: reportIds } },
          data: { watchlistId, status: params.status },
        })
      )
    );
  }

  async bulkLinkGlobalWatchlistWithSystemStatus(params: {
    links: Array<{ reportId: string; globalWatchlistId: string }>;
    systemStatus: SystemReportStatus;
  }): Promise<void> {
    if (params.links.length === 0) return;

    const groupedByWatchlist = new Map<string, string[]>();
    for (const link of params.links) {
      const reportIds = groupedByWatchlist.get(link.globalWatchlistId) || [];
      reportIds.push(link.reportId);
      groupedByWatchlist.set(link.globalWatchlistId, reportIds);
    }

    await Promise.all(
      Array.from(groupedByWatchlist.entries()).map(([globalWatchlistId, reportIds]) =>
        this.prismaClient.bookingReport.updateMany({
          where: { id: { in: reportIds } },
          data: { globalWatchlistId, systemStatus: params.systemStatus },
        })
      )
    );
  }

  async countPendingReports(params: { organizationId: number }): Promise<number> {
    return this.prismaClient.bookingReport.count({
      where: {
        organizationId: params.organizationId,
        status: "PENDING",
        watchlistId: null,
      },
    });
  }

  async updateSystemReportStatus(params: {
    reportId: string;
    systemStatus: SystemReportStatus;
    globalWatchlistId?: string | null;
  }): Promise<void> {
    await this.prismaClient.bookingReport.update({
      where: { id: params.reportId },
      data: {
        systemStatus: params.systemStatus,
        ...(params.globalWatchlistId !== undefined && { globalWatchlistId: params.globalWatchlistId }),
      },
    });
  }

  async bulkUpdateSystemReportStatus(params: {
    reportIds: string[];
    systemStatus: SystemReportStatus;
    globalWatchlistId?: string | null;
  }): Promise<{ updated: number }> {
    const result = await this.prismaClient.bookingReport.updateMany({
      where: { id: { in: params.reportIds } },
      data: {
        systemStatus: params.systemStatus,
        ...(params.globalWatchlistId !== undefined && { globalWatchlistId: params.globalWatchlistId }),
      },
    });
    return { updated: result.count };
  }

  async countSystemPendingReports(): Promise<number> {
    return this.prismaClient.bookingReport.count({
      where: {
        systemStatus: "PENDING",
      },
    });
  }

  // One guarded statement keeps a dismissal atomic, and json_each keeps any number of ids within D1's bind limit.
  async dismissReportsByEmail(params: {
    email: string;
    status: BookingReportStatus;
    organizationId: number;
  }): Promise<{ count: number }> {
    const reports = await this.findPendingReports(params.email, params.organizationId);
    if (reports.length === 0) return { count: 0 };

    const result = await getD1Database()
      .prepare(`UPDATE "BookingReport" SET "status" = ?, "updatedAt" = ? WHERE "id" IN (SELECT value FROM json_each(?))
        AND "watchlistId" IS NULL AND "status" = 'PENDING' AND "organizationId" = ?`)
      .bind(
        params.status,
        serializeDate(new Date()),
        JSON.stringify(reports.map((report) => report.id)),
        params.organizationId
      )
      .run();
    return { count: result.meta.changes };
  }

  async dismissSystemReportsByEmail(params: {
    email: string;
    systemStatus: SystemReportStatus;
  }): Promise<{ count: number }> {
    const reports = await this.findPendingSystemReports(params.email);
    if (reports.length === 0) return { count: 0 };

    const result = await getD1Database()
      .prepare(`UPDATE "BookingReport" SET "systemStatus" = ?, "updatedAt" = ? WHERE "id" IN (SELECT value FROM json_each(?))
        AND "globalWatchlistId" IS NULL AND "systemStatus" = 'PENDING'`)
      .bind(
        params.systemStatus,
        serializeDate(new Date()),
        JSON.stringify(reports.map((report) => report.id))
      )
      .run();
    return { count: result.meta.changes };
  }

  async findPendingReportsByEmail(params: {
    email: string;
    organizationId: number;
  }): Promise<Array<{ id: string; bookerEmail: string; watchlistId: string | null }>> {
    return this.findPendingReports(params.email, params.organizationId);
  }

  async findPendingReportsByDomain(params: {
    domain: string;
    organizationId: number;
  }): Promise<Array<{ id: string; bookerEmail: string; watchlistId: string | null }>> {
    return this.findPendingReports(`%@${params.domain}`, params.organizationId);
  }

  async findPendingSystemReportsByEmail(params: {
    email: string;
  }): Promise<Array<{ id: string; bookerEmail: string; globalWatchlistId: string | null }>> {
    return this.findPendingSystemReports(params.email);
  }

  async findPendingSystemReportsByDomain(params: {
    domain: string;
  }): Promise<Array<{ id: string; bookerEmail: string; globalWatchlistId: string | null }>> {
    return this.findPendingSystemReports(`%@${params.domain}`);
  }
}
