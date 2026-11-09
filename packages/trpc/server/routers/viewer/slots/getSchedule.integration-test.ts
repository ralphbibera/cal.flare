import { prisma } from "@calcom/prisma";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect } from "vitest";
import { getScheduleHandler } from "./getSchedule.handler";
import { ZGetScheduleInputSchema } from "./types";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../apps/web/cloudflare.config")).default.worker,
  setupTimeout: 120_000,
});

const startTime = "2027-03-01T00:00:00.000Z";
const endTime = "2027-03-02T00:00:00.000Z";

const createUser = (username: string) =>
  prisma.user.create({
    data: { email: `${username}@example.com`, username, name: username, timeZone: "UTC" },
  });

const createEventType = async (userId: number) => {
  const schedule = await prisma.schedule.create({
    data: {
      userId,
      name: "Working hours",
      timeZone: "UTC",
      availability: {
        create: {
          days: [1],
          startTime: new Date(Date.UTC(1970, 0, 1, 9)),
          endTime: new Date(Date.UTC(1970, 0, 1, 17)),
        },
      },
    },
  });
  await prisma.user.update({ where: { id: userId }, data: { defaultScheduleId: schedule.id } });
  return prisma.eventType.create({
    data: {
      title: "Intro",
      slug: "intro",
      length: 30,
      slotInterval: 30,
      timeZone: "UTC",
      minimumBookingNotice: 0,
      owner: { connect: { id: userId } },
      schedule: { connect: { id: schedule.id } },
      users: { connect: { id: userId } },
    },
  });
};

const getSlots = (eventTypeId: number) =>
  getScheduleHandler({
    ctx: {},
    input: { eventTypeId, startTime, endTime, timeZone: "UTC" },
  });

d1.beforeEach(async () => {
  await d1.db.batch([
    d1.db.prepare('DELETE FROM "SelectedSlots"'),
    d1.db.prepare('DELETE FROM "Watchlist"'),
    d1.db.prepare('DELETE FROM "users"'),
    d1.db.prepare('DELETE FROM "Team"'),
  ]);
});

describe("available slots on D1", () => {
  d1.it("returns the configured weekly slots for the requested UTC day", async () => {
    const user = await createUser("owner");
    const eventType = await createEventType(user.id);

    const result = await getSlots(eventType.id);
    const slots = result.slots["2027-03-01"];

    expect(Object.keys(result.slots)).toEqual(["2027-03-01"]);
    expect(slots.map((slot) => slot.time)).toContain("2027-03-01T09:00:00.000Z");
    expect(slots.map((slot) => slot.time)).toContain("2027-03-01T16:30:00.000Z");
  });

  d1.it("removes an unexpired reservation and deletes the expired ones", async () => {
    const user = await createUser("owner");
    const eventType = await createEventType(user.id);
    const now = Date.now();
    await prisma.selectedSlots.createMany({
      data: [
        {
          eventTypeId: eventType.id,
          userId: user.id,
          slotUtcStartDate: new Date("2027-03-01T09:00:00.000Z"),
          slotUtcEndDate: new Date("2027-03-01T09:30:00.000Z"),
          uid: "another-booker",
          releaseAt: new Date(now + 10 * 60 * 1000),
        },
        {
          eventTypeId: eventType.id,
          userId: user.id,
          slotUtcStartDate: new Date("2027-03-01T10:00:00.000Z"),
          slotUtcEndDate: new Date("2027-03-01T10:30:00.000Z"),
          uid: "another-booker",
          releaseAt: new Date(now - 10 * 60 * 1000),
        },
      ],
    });

    const result = await getSlots(eventType.id);
    const times = result.slots["2027-03-01"].map((slot) => slot.time);

    expect(times).not.toContain("2027-03-01T09:00:00.000Z");
    expect(times).toContain("2027-03-01T10:00:00.000Z");
    expect(await prisma.selectedSlots.count()).toBe(1);
  });

  d1.it("returns no slots when every host is blocked", async () => {
    const user = await createUser("owner");
    const eventType = await createEventType(user.id);
    await prisma.user.update({ where: { id: user.id }, data: { locked: true } });

    await expect(getSlots(eventType.id)).resolves.toEqual({ slots: {} });
  });

  d1.it("returns NOT_FOUND for an unknown event type", async () => {
    await expect(getSlots(999)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  d1.it("rejects invalid slot input at the schema boundary", () => {
    expect(
      ZGetScheduleInputSchema.safeParse({ eventTypeId: 1, startTime: "not-a-date", endTime }).success
    ).toBe(false);
    expect(
      ZGetScheduleInputSchema.safeParse({ eventTypeId: 1, startTime: endTime, endTime: startTime }).success
    ).toBe(false);
    expect(ZGetScheduleInputSchema.safeParse({ startTime, endTime, timeZone: "UTC" }).success).toBe(false);
  });
});
