import type { KeysetPage } from "@calcom/lib/keyset-scan";
import { findMatchingKeysetRows } from "@calcom/lib/keyset-scan";
import { createContainsInsensitiveMatcher } from "@calcom/lib/postgres-ilike";
import type { PrismaClient } from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { d1Boolean, d1DateTime, generateUuidV7, runD1Batch } from "@calcom/prisma/d1-batch";
import { WatchlistAction, WatchlistSource } from "@calcom/prisma/enums";
import { WatchlistSchema } from "@calcom/prisma/zod/modelSchema/WatchlistSchema";
import { z } from "zod";
import type {
  CheckWatchlistInput,
  CreateWatchlistInput,
  FindAllEntriesInput,
  IWatchlistRepository,
  WatchlistAuditEntry,
  WatchlistEntry,
} from "./IWatchlistRepository";

// A to-many relation with a nested `take` exceeds D1's 100 bind limit from 99 parent rows.
const SEARCH_SCAN_BATCH_SIZE = 50;

const entrySelect = {
  id: true,
  type: true,
  value: true,
  action: true,
  description: true,
  organizationId: true,
  isGlobal: true,
  source: true,
  lastUpdatedAt: true,
  audits: {
    take: 1,
    orderBy: {
      changedAt: "desc",
    },
    select: {
      changedByUserId: true,
    },
  },
} as const;

const watchlistRow = WatchlistSchema.extend({
  id: z.string(),
  isGlobal: d1Boolean,
  lastUpdatedAt: d1DateTime,
});

type AuditedEntry = Pick<WatchlistAuditEntry, "type" | "value" | "action"> & {
  watchlistId: string;
  description?: string | null;
};

// One JSON-bound statement keeps a bulk audit within D1's bound parameter limit.
function auditInsert(db: ReturnType<typeof getD1Database>, entries: AuditedEntry[], changedByUserId: number) {
  return db
    .prepare(
      `INSERT INTO "WatchlistAudit" ("id", "watchlistId", "type", "value", "description", "action", "changedByUserId")
      SELECT value ->> 'id', value ->> 'watchlistId', value ->> 'type', value ->> 'value', value ->> 'description',
        value ->> 'action', ? FROM json_each(?)`
    )
    .bind(
      changedByUserId,
      JSON.stringify(
        entries.map((entry) => ({
          id: generateUuidV7(),
          watchlistId: entry.watchlistId,
          type: entry.type,
          value: entry.value,
          description: entry.description ?? null,
          action: entry.action,
        }))
      )
    );
}

export class WatchlistRepository implements IWatchlistRepository {
  constructor(private readonly prismaClient: PrismaClient) {}

  // SQLite only folds ASCII, so a search matches in memory within the scoped rows before the page is cut.
  private async findSearchedEntries(
    where: Prisma.WatchlistWhereInput,
    searchTerm: string,
    limit: number,
    offset: number
  ) {
    const matches = createContainsInsensitiveMatcher(searchTerm);
    const matched = await findMatchingKeysetRows({
      take: SEARCH_SCAN_BATCH_SIZE,
      getKey: (entry) => entry.id,
      matches: (entry) => matches(entry.value),
      fetchRows: ({ after, take }: KeysetPage<string>) =>
        this.prismaClient.watchlist.findMany({
          where: { ...where, ...(after && { id: { gt: after } }) },
          take,
          orderBy: { id: "asc" },
          select: entrySelect,
        }),
    });
    matched.sort((a, b) => b.lastUpdatedAt.getTime() - a.lastUpdatedAt.getTime() || (a.id < b.id ? -1 : 1));
    return [matched.slice(offset, offset + limit), matched.length] as const;
  }

  async createEntry(params: CreateWatchlistInput): Promise<WatchlistEntry> {
    const db = getD1Database();
    const id = crypto.randomUUID();
    const results = await runD1Batch(
      db,
      [
        db
          .prepare(
            `INSERT INTO "Watchlist" ("id", "type", "value", "organizationId", "action", "description", "source", "isGlobal")
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .bind(
            id,
            params.type,
            params.value,
            params.organizationId,
            params.action,
            params.description ?? null,
            WatchlistSource.MANUAL,
            Number(params.isGlobal ?? false)
          ),
        auditInsert(db, [{ ...params, watchlistId: id }], params.userId),
        db.prepare('SELECT * FROM "Watchlist" WHERE "id" = ?').bind(id),
      ],
      { modelName: "Watchlist" }
    );
    return watchlistRow.parse(results[2].results[0]);
  }

  async createEntryIfNotExists(params: CreateWatchlistInput): Promise<WatchlistEntry> {
    const existing = await this.checkExists({
      type: params.type,
      value: params.value,
      organizationId: params.organizationId,
      isGlobal: params.isGlobal,
    });

    if (existing) {
      return existing;
    }

    return this.createEntry(params);
  }

  async checkExists(params: CheckWatchlistInput): Promise<WatchlistEntry | null> {
    if (!params.isGlobal && !params.organizationId) {
      throw new Error("Both isGlobal and organizationId are missing");
    }

    if (params.isGlobal) {
      const entry = await this.prismaClient.watchlist.findFirst({
        where: {
          type: params.type,
          value: params.value,
          isGlobal: true,
          organizationId: null,
        },
      });
      return entry;
    } else if (params.organizationId) {
      const entry = await this.prismaClient.watchlist.findUnique({
        where: {
          type_value_organizationId: {
            type: params.type,
            value: params.value,
            organizationId: params.organizationId,
          },
        },
      });

      return entry;
    }

    return null;
  }

  async findAllEntriesWithLatestAudit(params: FindAllEntriesInput): Promise<{
    rows: (WatchlistEntry & { latestAudit: { changedByUserId: number | null } | null })[];
    meta: { totalRowCount: number };
  }> {
    const where = {
      organizationId: params.organizationId,
      isGlobal: params.isGlobal,
      ...(params.filters?.type && {
        type: params.filters.type,
      }),
      ...(params.filters?.source && {
        source: params.filters.source,
      }),
    };

    const [entries, totalRowCount] = await (params.searchTerm
      ? this.findSearchedEntries(where, params.searchTerm, params.limit, params.offset)
      : Promise.all([
          this.prismaClient.watchlist.findMany({
            where,
            take: params.limit,
            skip: params.offset,
            orderBy: {
              lastUpdatedAt: "desc",
            },
            select: entrySelect,
          }),
          this.prismaClient.watchlist.count({ where }),
        ]));

    const rows = entries.map((entry) => ({
      ...entry,
      latestAudit: entry.audits[0] ?? null,
      audits: undefined,
    }));

    return {
      rows,
      meta: { totalRowCount },
    };
  }

  async findEntryWithAuditAndReports(id: string): Promise<{
    entry:
      | (WatchlistEntry & {
          bookingReports?: Array<{
            booking: {
              uid: string;
              title: string | null;
            };
          }>;
        })
      | null;
    auditHistory: WatchlistAuditEntry[];
  }> {
    const bookingReportSelect = {
      select: {
        booking: {
          select: {
            uid: true,
            title: true,
          },
        },
      },
    } as const;

    const entry = await this.prismaClient.watchlist.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        value: true,
        action: true,
        description: true,
        organizationId: true,
        isGlobal: true,
        source: true,
        lastUpdatedAt: true,
        bookingReports: bookingReportSelect,
        globalBookingReports: bookingReportSelect,
        audits: {
          select: {
            id: true,
            watchlistId: true,
            type: true,
            value: true,
            description: true,
            action: true,
            changedByUserId: true,
            changedAt: true,
          },
          orderBy: {
            changedAt: "desc",
          },
        },
      },
    });

    const allBookingReports = [...(entry?.bookingReports ?? []), ...(entry?.globalBookingReports ?? [])];

    return {
      entry: entry
        ? {
            id: entry.id,
            type: entry.type,
            value: entry.value,
            action: entry.action,
            description: entry.description ?? null,
            organizationId: entry.organizationId ?? null,
            isGlobal: entry.isGlobal,
            source: entry.source,
            lastUpdatedAt: entry.lastUpdatedAt,
            bookingReports: allBookingReports,
          }
        : null,
      auditHistory: entry?.audits || [],
    };
  }

  async findEntriesByIds(ids: string[]): Promise<
    Array<{
      id: string;
      isGlobal: boolean;
      organizationId: number | null;
      source: WatchlistSource;
      type: WatchlistEntry["type"];
      value: string;
    }>
  > {
    return this.prismaClient.watchlist.findMany({
      where: { id: { in: ids } },
      select: {
        id: true,
        isGlobal: true,
        organizationId: true,
        source: true,
        type: true,
        value: true,
      },
    });
  }

  async deleteEntry(id: string, userId: number): Promise<void> {
    const existing = await this.prismaClient.watchlist.findUnique({
      where: { id },
      select: {
        id: true,
        type: true,
        value: true,
        description: true,
        action: true,
      },
    });

    if (!existing) {
      throw new Error("Watchlist entry not found");
    }

    const db = getD1Database();
    await runD1Batch(
      db,
      [
        auditInsert(db, [{ ...existing, watchlistId: id }], userId),
        db.prepare('DELETE FROM "Watchlist" WHERE "id" = ?').bind(id),
      ],
      { modelName: "Watchlist" }
    );
  }

  async bulkDeleteEntries(params: { ids: string[]; userId: number }): Promise<{ deleted: number }> {
    const entries = await this.prismaClient.watchlist.findMany({
      where: { id: { in: params.ids } },
      select: {
        id: true,
        type: true,
        value: true,
        description: true,
        action: true,
      },
    });

    if (entries.length === 0) {
      return { deleted: 0 };
    }

    const db = getD1Database();
    await runD1Batch(
      db,
      [
        auditInsert(
          db,
          entries.map((entry) => ({ ...entry, watchlistId: entry.id })),
          params.userId
        ),
        db
          .prepare('DELETE FROM "Watchlist" WHERE "id" IN (SELECT value FROM json_each(?))')
          .bind(JSON.stringify(entries.map((entry) => entry.id))),
      ],
      { modelName: "Watchlist" }
    );

    return { deleted: entries.length };
  }

  async createEntryFromReport(params: {
    type: CreateWatchlistInput["type"];
    value: string;
    organizationId: number | null;
    isGlobal: boolean;
    userId: number;
    description?: string;
  }): Promise<{ watchlistEntry: WatchlistEntry; value: string }> {
    const watchlistEntry = await this.createEntryIfNotExists({
      type: params.type,
      value: params.value,
      organizationId: params.organizationId,
      isGlobal: params.isGlobal,
      action: WatchlistAction.BLOCK,
      description: params.description,
      userId: params.userId,
    });

    return { watchlistEntry, value: params.value };
  }

  async findOrgAndGlobalEntries(params: {
    organizationId: number;
    limit: number;
    offset: number;
    searchTerm?: string;
    filters?: {
      type?: NonNullable<FindAllEntriesInput["filters"]>["type"];
      source?: NonNullable<FindAllEntriesInput["filters"]>["source"];
    };
  }): Promise<{
    rows: (WatchlistEntry & {
      latestAudit: { changedByUserId: number | null } | null;
      isReadOnly: boolean;
    })[];
    meta: { totalRowCount: number };
  }> {
    const where = {
      OR: [
        { organizationId: params.organizationId, isGlobal: false },
        { isGlobal: true, organizationId: null },
      ],
      ...(params.filters?.type && {
        type: params.filters.type,
      }),
      ...(params.filters?.source && {
        source: params.filters.source,
      }),
    };

    const [entries, totalRowCount] = await (params.searchTerm
      ? this.findSearchedEntries(where, params.searchTerm, params.limit, params.offset)
      : Promise.all([
          this.prismaClient.watchlist.findMany({
            where,
            take: params.limit,
            skip: params.offset,
            orderBy: {
              lastUpdatedAt: "desc",
            },
            select: entrySelect,
          }),
          this.prismaClient.watchlist.count({ where }),
        ]));

    const rows = entries.map((entry) => ({
      ...entry,
      latestAudit: entry.audits[0] ?? null,
      audits: undefined,
      isReadOnly: entry.isGlobal,
    }));

    return {
      rows,
      meta: { totalRowCount },
    };
  }
}
