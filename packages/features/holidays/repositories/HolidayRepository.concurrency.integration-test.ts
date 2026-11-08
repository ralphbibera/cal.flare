import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect } from "vitest";
import { HolidayRepository } from "./HolidayRepository";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../apps/web/cloudflare.config")).default.worker,
  setupTimeout: 60_000,
});

const countryCode = "US";
const year = 2025;
const holiday = (eventId: string, name = eventId) => ({
  countryCode,
  calendarId: "calendar",
  eventId,
  name,
  date: new Date("2025-01-01"),
  year,
});
const OLD = ["old-1", "old-2", "old-3"];
const NEXT = Array.from({ length: 40 }, (_, index) => `new-${index}`);
const INVALID = Array.from({ length: 40 }, (_, index) => `invalid-${index}`);

describe("refreshing the holiday cache twice", () => {
  const cached = () =>
    HolidayRepository.findManyCachedHolidays({ countryCode, year }).then((rows) =>
      rows.map(({ eventId }) => eventId).sort()
    );

  d1.beforeEach(async () => {
    await HolidayRepository.refreshCache({ countryCode, year, holidays: OLD.map((id) => holiday(id)) });
  });

  d1.it(
    "keeps the cache complete when a refresh overlaps one that fails",
    async () => {
      const invalidLast = holiday("invalid-last");
      Object.defineProperty(invalidLast, "name", { value: null });
      let done = false;
      const reader = (async () => {
        const seen: string[][] = [];
        while (!done && seen.length < 1_000) seen.push(await cached());
        return seen;
      })();

      // The original refresh ran in one interactive transaction, so a failed refresh never deleted the
      // previous cache and readers never observed the delete-without-insert state.
      const results = await Promise.allSettled([
        HolidayRepository.refreshCache({ countryCode, year, holidays: NEXT.map((id) => holiday(id)) }),
        HolidayRepository.refreshCache({
          countryCode,
          year,
          holidays: [...INVALID.map((id) => holiday(id)), invalidLast],
        }),
      ]);
      done = true;

      expect(results.map(({ status }) => status).sort()).toEqual(["fulfilled", "rejected"]);
      expect(results.find(({ status }) => status === "rejected")).toMatchObject({
        reason: { message: expect.stringContaining("NOT NULL constraint failed") },
      });
      expect(await cached()).toEqual([...NEXT].sort());
      const seen = await reader;
      expect(new Set(seen.map((ids) => ids.join()))).toEqual(
        new Set([[...OLD].sort().join(), [...NEXT].sort().join()])
      );
      expect(
        seen.every((ids) => ids.join() === [...OLD].sort().join() || ids.join() === [...NEXT].sort().join())
      ).toBe(true);
    },
    30_000
  );
});
