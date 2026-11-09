import dayjs from "@calcom/dayjs";
import { prisma } from "@calcom/prisma";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import type { TrpcSessionUser } from "@calcom/trpc/server/types";
import { describe, expect, vi } from "vitest";
import { userHandler } from "./user.handler";

const busyTimes = vi.hoisted(() => ({ getBusyTimes: vi.fn() }));

vi.mock("@calcom/features/di/containers/BusyTimes", () => ({
  getBusyTimesService: () => busyTimes,
}));

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../apps/web/cloudflare.config")).default.worker,
  setupTimeout: 120_000,
});

const dateFrom = dayjs.utc("2027-03-01T00:00:00.000Z");
const dateTo = dayjs.utc("2027-03-08T00:00:00.000Z");
const context = (id: number) => ({ user: { id } as NonNullable<TrpcSessionUser> });

const createUser = (username: string) =>
  prisma.user.create({
    data: { email: `${username}@example.com`, username, name: username, timeZone: "UTC" },
  });

const createScheduledUser = async (username: string) => {
  const user = await createUser(username);
  const schedule = await prisma.schedule.create({
    data: {
      userId: user.id,
      name: "Working hours",
      timeZone: "UTC",
      availability: {
        create: {
          days: [1, 2, 3, 4, 5],
          startTime: new Date(Date.UTC(1970, 0, 1, 9)),
          endTime: new Date(Date.UTC(1970, 0, 1, 17)),
        },
      },
    },
  });
  await prisma.user.update({ where: { id: user.id }, data: { defaultScheduleId: schedule.id } });
  return user;
};

d1.beforeEach(async () => {
  busyTimes.getBusyTimes.mockReset();
  busyTimes.getBusyTimes.mockResolvedValue([]);
  await d1.db.batch([d1.db.prepare('DELETE FROM "users"'), d1.db.prepare('DELETE FROM "Team"')]);
});

describe("availability user handler on D1", () => {
  d1.it("resolves the default schedule into working hours, date ranges and time zone", async () => {
    const user = await createScheduledUser("owner");
    const result = await userHandler({
      ctx: context(user.id),
      input: { username: "owner", dateFrom, dateTo },
    });

    expect(result.timeZone).toBe("UTC");
    expect(result.workingHours).toEqual([
      { days: [1, 2, 3, 4, 5], startTime: 540, endTime: 1020, userId: user.id },
    ]);
    expect(
      result.dateRanges.map(({ start, end }) => [start.toISOString(), end.toISOString()])
    ).toContainEqual(["2027-03-01T09:00:00.000Z", "2027-03-01T17:00:00.000Z"]);
  });

  d1.it("returns NOT_FOUND for an unknown user", async () => {
    await expect(
      userHandler({ ctx: context(1), input: { username: "missing", dateFrom, dateTo } })
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "User not found" });
  });

  d1.it("falls back to the source default schedule when the user has no stored availability", async () => {
    const user = await createUser("empty");
    const result = await userHandler({
      ctx: context(user.id),
      input: { username: "empty", dateFrom, dateTo },
    });

    expect(result.timeZone).toBe("UTC");
    expect(result.workingHours).toEqual([
      { days: [1, 2, 3, 4, 5], startTime: 540, endTime: 1020, userId: user.id },
    ]);
    expect(result.dateRanges).toHaveLength(5);
  });

  d1.it("returns empty availability rather than unrestricted time when the busy provider fails", async () => {
    const user = await createScheduledUser("owner");
    busyTimes.getBusyTimes.mockRejectedValueOnce(new Error("provider down"));

    const result = await userHandler({
      ctx: context(user.id),
      input: { username: "owner", dateFrom, dateTo },
    });

    expect(result).toMatchObject({
      busy: [],
      timeZone: "UTC",
      dateRanges: [],
      oooExcludedDateRanges: [],
      workingHours: [],
      dateOverrides: [],
      currentSeats: [],
    });
  });
});
