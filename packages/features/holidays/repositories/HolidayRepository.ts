import { prisma } from "@calcom/prisma";
import type { HolidayCache, Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { BookingStatus } from "@calcom/prisma/enums";
import { z } from "zod";

const cacheColumns =
  '"id", "countryCode", "calendarId", "eventId", "name", "date", "year", "createdAt", "updatedAt"';
const cacheDate = z
  .string()
  .datetime({ offset: true })
  .transform((value) => new Date(value));
const cacheRow = z.object({
  id: z.string(),
  countryCode: z.string(),
  calendarId: z.string(),
  eventId: z.string(),
  name: z.string(),
  date: cacheDate,
  year: z.number().int(),
  createdAt: cacheDate,
  updatedAt: cacheDate,
}) satisfies z.ZodType<HolidayCache, z.ZodTypeDef, unknown>;
const serializeDate = (value: Date | string) => new Date(value).toISOString().replace("Z", "+00:00");

function cacheInsert(db: ReturnType<typeof getD1Database>, data: Prisma.HolidayCacheCreateManyInput[]) {
  const now = new Date();
  return data.map((row) =>
    db
      .prepare(`INSERT INTO "HolidayCache" (${cacheColumns})
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT DO NOTHING`)
      .bind(
        row.id ?? crypto.randomUUID(),
        row.countryCode,
        row.calendarId,
        row.eventId,
        row.name,
        serializeDate(row.date),
        row.year,
        serializeDate(row.createdAt ?? now),
        serializeDate(row.updatedAt ?? now)
      )
  );
}

const userHolidaySettingsSelect = {
  id: true,
  userId: true,
  countryCode: true,
  disabledIds: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.UserHolidaySettingsSelect;

export class HolidayRepository {
  static async findFirstCacheEntry({ countryCode, year }: { countryCode: string; year: number }) {
    const row = await getD1Database()
      .prepare(`SELECT ${cacheColumns} FROM "HolidayCache"
      WHERE "countryCode" = ? AND "year" = ? ORDER BY "updatedAt" DESC LIMIT 1`)
      .bind(countryCode, year)
      .first();
    return row === null ? null : cacheRow.parse(row);
  }

  static async findManyCachedHolidays({ countryCode, year }: { countryCode: string; year: number }) {
    const { results } = await getD1Database()
      .prepare(`SELECT ${cacheColumns} FROM "HolidayCache"
      WHERE "countryCode" = ? AND "year" = ? ORDER BY "date" ASC`)
      .bind(countryCode, year)
      .all();
    return cacheRow.array().parse(results);
  }

  static async findCachedHolidaysInRange({
    countryCode,
    startDate,
    endDate,
  }: {
    countryCode: string;
    startDate: Date;
    endDate: Date;
  }) {
    const { results } = await getD1Database()
      .prepare(`SELECT ${cacheColumns} FROM "HolidayCache"
      WHERE "countryCode" = ? AND "date" >= ? AND "date" <= ? ORDER BY "date" ASC`)
      .bind(countryCode, serializeDate(startDate), serializeDate(endDate))
      .all();
    return cacheRow.array().parse(results);
  }

  static async deleteManyCacheEntries({ countryCode, year }: { countryCode: string; year: number }) {
    const result = await getD1Database()
      .prepare('DELETE FROM "HolidayCache" WHERE "countryCode" = ? AND "year" = ?')
      .bind(countryCode, year)
      .run();
    return { count: result.meta.changes };
  }

  static async createManyCacheEntries(data: Prisma.HolidayCacheCreateManyInput[]) {
    if (data.length === 0) return { count: 0 };
    const db = getD1Database();
    const results = await db.batch(cacheInsert(db, data));
    return { count: results.reduce((count, result) => count + result.meta.changes, 0) };
  }

  static async refreshCache({
    countryCode,
    year,
    holidays,
  }: {
    countryCode: string;
    year: number;
    holidays: Prisma.HolidayCacheCreateManyInput[];
  }) {
    const db = getD1Database();
    const inserts = cacheInsert(db, holidays);
    await db.batch([
      db.prepare('DELETE FROM "HolidayCache" WHERE "countryCode" = ? AND "year" = ?').bind(countryCode, year),
      ...inserts,
    ]);
  }

  static async findUserSettings({ userId }: { userId: number }) {
    return prisma.userHolidaySettings.findUnique({
      where: { userId },
      select: userHolidaySettingsSelect,
    });
  }

  static async findUserSettingsSelect<T extends Prisma.UserHolidaySettingsSelect>({
    userId,
    select,
  }: {
    userId: number;
    select: T;
  }) {
    return prisma.userHolidaySettings.findUnique({
      where: { userId },
      select,
    });
  }

  static async upsertUserSettings({
    userId,
    countryCode,
    disabledIds = [],
    resetDisabledHolidays = false,
  }: {
    userId: number;
    countryCode: string | null;
    disabledIds?: string[];
    resetDisabledHolidays?: boolean;
  }) {
    return prisma.userHolidaySettings.upsert({
      where: { userId },
      create: {
        userId,
        countryCode,
        disabledIds,
      },
      update: {
        countryCode,
        ...(resetDisabledHolidays ? { disabledIds: [] } : {}),
      },
      select: userHolidaySettingsSelect,
    });
  }

  static async updateUserSettings({
    userId,
    data,
  }: {
    userId: number;
    data: Prisma.UserHolidaySettingsUpdateInput;
  }) {
    return prisma.userHolidaySettings.update({
      where: { userId },
      data,
      select: userHolidaySettingsSelect,
    });
  }

  static async updateDisabledIds({ userId, disabledIds }: { userId: number; disabledIds: string[] }) {
    return prisma.userHolidaySettings.update({
      where: { userId },
      data: { disabledIds },
      select: userHolidaySettingsSelect,
    });
  }

  static async findBookingsInDateRanges({
    userId,
    dateRanges,
  }: {
    userId: number;
    dateRanges: Array<{ start: Date; end: Date }>;
  }) {
    if (dateRanges.length === 0) return [];

    return prisma.booking.findMany({
      where: {
        userId,
        status: { in: [BookingStatus.ACCEPTED, BookingStatus.PENDING] },
        OR: dateRanges.map(({ start, end }) => ({
          AND: [{ startTime: { lt: end } }, { endTime: { gt: start } }],
        })),
      },
      select: {
        id: true,
        title: true,
        startTime: true,
        endTime: true,
        attendees: {
          take: 1,
          select: { name: true },
        },
      },
    });
  }
}
