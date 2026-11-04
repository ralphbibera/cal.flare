import prismaMock from "@calcom/testing/lib/__mocks__/prismaMock";
import { readFile } from "node:fs/promises";
import { withD1Database } from "@calcom/prisma/d1";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { HolidayRepository } from "./HolidayRepository";

describe("HolidayRepository", () => {
  const mf = new Miniflare({
    enableDevRegistry: false,
    telemetry: { enabled: false },
    workers: [
      {
        config: {
          name: "holiday-cache",
          compatibilityDate: "2026-11-04",
          compatibilityFlags: ["nodejs_compat"],
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default { fetch() { return new Response(); } }" },
            },
          },
          env: {
            DB: { type: "d1", name: "holiday-cache", dev: { remote: false } },
            OTHER_DB: { type: "d1", name: "other-cache", dev: { remote: false } },
          },
        },
      },
    ],
  });
  let db: Awaited<ReturnType<typeof mf.getD1Database>>;
  beforeAll(async () => {
    db = await mf.getD1Database("DB");
    const sql = await readFile(
      new URL("../../../prisma/migrations-d1/0001_holiday_cache.sql", import.meta.url),
      "utf8"
    );
    await db.batch(
      sql
        .split(";")
        .filter((statement) => statement.trim())
        .map((statement) => db.prepare(statement))
    );
  });
  afterAll(() => mf.dispose());
  const cache = <T>(callback: () => T) => withD1Database({ DB: db }, callback);

  beforeEach(async () => {
    vi.clearAllMocks();
    await db.prepare('DELETE FROM "HolidayCache"').run();
  });

  describe("findUserSettings", () => {
    it("should return user holiday settings when they exist", async () => {
      const mockSettings = {
        id: 1,
        userId: 123,
        countryCode: "US",
        disabledIds: ["holiday_1", "holiday_2"],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prismaMock.userHolidaySettings.findUnique.mockResolvedValue(mockSettings);

      const result = await HolidayRepository.findUserSettings({ userId: 123 });

      expect(prismaMock.userHolidaySettings.findUnique).toHaveBeenCalledWith({
        where: { userId: 123 },
        select: {
          id: true,
          userId: true,
          countryCode: true,
          disabledIds: true,
          createdAt: true,
          updatedAt: true,
        },
      });
      expect(result).toEqual(mockSettings);
    });

    it("should return null when user has no holiday settings", async () => {
      prismaMock.userHolidaySettings.findUnique.mockResolvedValue(null);

      const result = await HolidayRepository.findUserSettings({ userId: 456 });

      expect(prismaMock.userHolidaySettings.findUnique).toHaveBeenCalledWith({
        where: { userId: 456 },
        select: expect.any(Object),
      });
      expect(result).toBeNull();
    });
  });

  describe("findUserSettingsSelect", () => {
    it("should return user settings with custom select", async () => {
      const mockSettings = {
        id: 1,
        userId: 123,
        createdAt: new Date(),
        updatedAt: new Date(),
        countryCode: "GB",
        disabledIds: [],
      };

      prismaMock.userHolidaySettings.findUnique.mockResolvedValue(mockSettings);

      const result = await HolidayRepository.findUserSettingsSelect({
        userId: 123,
        select: {
          countryCode: true,
          disabledIds: true,
        },
      });

      expect(prismaMock.userHolidaySettings.findUnique).toHaveBeenCalledWith({
        where: { userId: 123 },
        select: {
          countryCode: true,
          disabledIds: true,
        },
      });
      expect(result).toEqual(mockSettings);
    });
  });

  describe("upsertUserSettings", () => {
    it("should create new settings when user has none", async () => {
      const mockSettings = {
        id: 1,
        userId: 123,
        countryCode: "US",
        disabledIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prismaMock.userHolidaySettings.upsert.mockResolvedValue(mockSettings);

      const result = await HolidayRepository.upsertUserSettings({
        userId: 123,
        countryCode: "US",
      });

      expect(prismaMock.userHolidaySettings.upsert).toHaveBeenCalledWith({
        where: { userId: 123 },
        create: {
          userId: 123,
          countryCode: "US",
          disabledIds: [],
        },
        update: {
          countryCode: "US",
        },
        select: expect.any(Object),
      });
      expect(result).toEqual(mockSettings);
    });

    it("should reset disabled holidays when resetDisabledHolidays is true", async () => {
      const mockSettings = {
        id: 1,
        userId: 123,
        countryCode: "GB",
        disabledIds: [],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prismaMock.userHolidaySettings.upsert.mockResolvedValue(mockSettings);

      const result = await HolidayRepository.upsertUserSettings({
        userId: 123,
        countryCode: "GB",
        resetDisabledHolidays: true,
      });

      expect(prismaMock.userHolidaySettings.upsert).toHaveBeenCalledWith({
        where: { userId: 123 },
        create: {
          userId: 123,
          countryCode: "GB",
          disabledIds: [],
        },
        update: {
          countryCode: "GB",
          disabledIds: [],
        },
        select: expect.any(Object),
      });
      expect(result).toEqual(mockSettings);
    });
  });

  describe("updateDisabledIds", () => {
    it("should update disabled holiday IDs", async () => {
      const mockSettings = {
        id: 1,
        userId: 123,
        countryCode: "US",
        disabledIds: ["christmas_2025", "thanksgiving_2025"],
        createdAt: new Date(),
        updatedAt: new Date(),
      };

      prismaMock.userHolidaySettings.update.mockResolvedValue(mockSettings);

      const result = await HolidayRepository.updateDisabledIds({
        userId: 123,
        disabledIds: ["christmas_2025", "thanksgiving_2025"],
      });

      expect(prismaMock.userHolidaySettings.update).toHaveBeenCalledWith({
        where: { userId: 123 },
        data: { disabledIds: ["christmas_2025", "thanksgiving_2025"] },
        select: expect.any(Object),
      });
      expect(result).toEqual(mockSettings);
    });
  });

  describe("findManyCachedHolidays", () => {
    it("should return cached holidays for country and year", async () => {
      const mockHolidays = [
        {
          id: "1",
          countryCode: "US",
          calendarId: "en.usa.official#holiday@group.v.calendar.google.com",
          eventId: "new_years_day_2025",
          name: "New Year's Day",
          date: new Date("2025-01-01"),
          year: 2025,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
        {
          id: "2",
          countryCode: "US",
          calendarId: "en.usa.official#holiday@group.v.calendar.google.com",
          eventId: "christmas_2025",
          name: "Christmas Day",
          date: new Date("2025-12-25"),
          year: 2025,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      await cache(() => HolidayRepository.createManyCacheEntries([...mockHolidays].reverse()));

      const result = await cache(() =>
        HolidayRepository.findManyCachedHolidays({
          countryCode: "US",
          year: 2025,
        })
      );

      expect(result).toEqual(mockHolidays);
    });

    it("should return empty array when no holidays found", async () => {
      const result = await cache(() =>
        HolidayRepository.findManyCachedHolidays({
          countryCode: "XX",
          year: 2025,
        })
      );

      expect(result).toEqual([]);
    });
  });

  describe("findFirstCacheEntry", () => {
    it("should return first cache entry for staleness check", async () => {
      const mockEntry = {
        id: "1",
        countryCode: "US",
        calendarId: "en.usa.official#holiday@group.v.calendar.google.com",
        eventId: "new_years_day_2025",
        name: "New Year's Day",
        date: new Date("2025-01-01"),
        year: 2025,
        createdAt: new Date(),
        updatedAt: new Date("2025-01-15"),
      };

      await cache(() =>
        HolidayRepository.createManyCacheEntries([
          mockEntry,
          { ...mockEntry, id: "older", eventId: "older", updatedAt: new Date("2025-01-01") },
          { ...mockEntry, id: "other", countryCode: "GB", updatedAt: new Date("2025-02-01") },
        ])
      );

      const result = await cache(() =>
        HolidayRepository.findFirstCacheEntry({
          countryCode: "US",
          year: 2025,
        })
      );

      expect(result).toEqual(mockEntry);
    });

    it("should return null when no cache entry exists", async () => {
      const result = await cache(() =>
        HolidayRepository.findFirstCacheEntry({
          countryCode: "US",
          year: 2030,
        })
      );

      expect(result).toBeNull();
    });
  });

  describe("findCachedHolidaysInRange", () => {
    it("should return holidays within date range", async () => {
      const mockHolidays = [
        {
          id: "1",
          countryCode: "US",
          calendarId: "en.usa.official#holiday@group.v.calendar.google.com",
          eventId: "christmas_2025",
          name: "Christmas Day",
          date: new Date("2025-12-25"),
          year: 2025,
          createdAt: new Date(),
          updatedAt: new Date(),
        },
      ];

      await cache(() => HolidayRepository.createManyCacheEntries([...mockHolidays].reverse()));

      await cache(() =>
        HolidayRepository.createManyCacheEntries([
          { ...mockHolidays[0], id: "other", countryCode: "GB" },
          { ...mockHolidays[0], id: "outside", eventId: "outside", date: new Date("2025-12-26") },
        ])
      );
      const startDate = new Date("2025-12-25");
      const endDate = new Date("2025-12-25");

      const result = await cache(() =>
        HolidayRepository.findCachedHolidaysInRange({
          countryCode: "US",
          startDate,
          endDate,
        })
      );

      expect(result).toEqual(mockHolidays);
    });
  });
  const holiday = {
    countryCode: "US",
    calendarId: "calendar",
    eventId: "new-year",
    name: "New year",
    date: new Date("2025-01-01"),
    year: 2025,
  };

  it("preserves defaults, explicit values and skips all unique conflicts with accurate counts", async () => {
    await cache(async () => {
      const explicit = {
        ...holiday,
        id: "fixed",
        createdAt: new Date("2024-01-01"),
        updatedAt: new Date("2024-02-01"),
      };
      expect(
        await HolidayRepository.createManyCacheEntries([
          explicit,
          explicit,
          { ...holiday, id: "fixed", eventId: "another" },
          { ...holiday, countryCode: "GB" },
        ])
      ).toEqual({ count: 2 });
      expect(await HolidayRepository.findFirstCacheEntry(holiday)).toEqual(explicit);
      const generated = await HolidayRepository.findFirstCacheEntry({ ...holiday, countryCode: "GB" });
      expect(generated?.id).toMatch(/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/);
      expect(generated?.createdAt).toBeInstanceOf(Date);
      expect(generated?.updatedAt).toEqual(generated?.createdAt);
      expect(await HolidayRepository.createManyCacheEntries([])).toEqual({ count: 0 });
      await db
        .prepare(`INSERT INTO "HolidayCache" (id, countryCode, calendarId, eventId, name, date, year, updatedAt)
        VALUES ('sql-default', 'PH', 'calendar', 'sql-default', 'Holiday', ?, 2025, ?)`)
        .bind("2025-01-01T00:00:00.000+00:00", "2025-01-01T00:00:00.000+00:00")
        .run();
      expect(
        await db
          .prepare('SELECT "createdAt" FROM "HolidayCache" WHERE id = ?')
          .bind("sql-default")
          .first("createdAt")
      ).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}\+00:00$/);
      expect(
        (await HolidayRepository.findFirstCacheEntry({ countryCode: "PH", year: 2025 }))?.createdAt
      ).toBeInstanceOf(Date);
    });
  });

  it("refreshes only the selected country/year, accepts duplicates and empty refresh", async () => {
    await cache(async () => {
      await HolidayRepository.createManyCacheEntries([
        holiday,
        { ...holiday, countryCode: "GB" },
        { ...holiday, year: 2026, eventId: "next" },
      ]);
      const replacement = { ...holiday, eventId: "replacement" };
      await HolidayRepository.refreshCache({ ...holiday, holidays: [replacement, replacement] });
      expect((await HolidayRepository.findManyCachedHolidays(holiday)).map((row) => row.eventId)).toEqual([
        "replacement",
      ]);
      await HolidayRepository.refreshCache({ ...holiday, holidays: [] });
      expect(await HolidayRepository.findManyCachedHolidays(holiday)).toEqual([]);
      expect(await HolidayRepository.deleteManyCacheEntries(holiday)).toEqual({ count: 0 });
      expect(await HolidayRepository.deleteManyCacheEntries({ ...holiday, countryCode: "GB" })).toEqual({
        count: 1,
      });
      expect((await HolidayRepository.findManyCachedHolidays({ ...holiday, year: 2026 })).length).toBe(1);
    });
  });

  it("rolls back deletion and earlier inserts when a later non-unique constraint fails", async () => {
    await cache(async () => {
      await HolidayRepository.createManyCacheEntries([holiday]);
      const old = await HolidayRepository.findManyCachedHolidays(holiday);
      const invalid = { ...holiday, eventId: "invalid" };
      Object.defineProperty(invalid, "name", { value: null });
      await expect(
        HolidayRepository.refreshCache({ ...holiday, holidays: [{ ...holiday, eventId: "valid" }, invalid] })
      ).rejects.toThrow("NOT NULL constraint failed");
      expect(await HolidayRepository.findManyCachedHolidays(holiday)).toEqual(old);
      await expect(
        HolidayRepository.createManyCacheEntries([{ ...holiday, eventId: "valid" }, invalid])
      ).rejects.toThrow("NOT NULL constraint failed");
      expect(await HolidayRepository.findManyCachedHolidays(holiday)).toEqual(old);
      await expect(
        HolidayRepository.refreshCache({ ...holiday, holidays: [{ ...holiday, date: "invalid" }] })
      ).rejects.toThrow();
      expect(await HolidayRepository.findManyCachedHolidays(holiday)).toEqual(old);
    });
  });

  it("isolates overlapping request bindings and clears completed context", async () => {
    const other = await mf.getD1Database("OTHER_DB");
    let release = () => {};
    const ready = new Promise<void>((resolve) => {
      release = resolve;
    });
    const first = cache(async () => {
      await ready;
      return HolidayRepository.findManyCachedHolidays(holiday);
    });
    await withD1Database({ DB: other }, async () => {
      release();
      await expect(HolidayRepository.findManyCachedHolidays(holiday)).rejects.toThrow(
        "no such table: HolidayCache"
      );
    });
    expect(await first).toEqual([]);
    await expect(HolidayRepository.findManyCachedHolidays(holiday)).rejects.toThrow(
      "D1 request binding is required"
    );
  });
});
