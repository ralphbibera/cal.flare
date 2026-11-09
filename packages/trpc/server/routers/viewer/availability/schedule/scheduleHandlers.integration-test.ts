import { ErrorCode } from "@calcom/lib/errorCodes";
import { prisma } from "@calcom/prisma";
import { SchedulingType } from "@calcom/prisma/enums";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect } from "vitest";
import { createHandler } from "./create.handler";
import { ZCreateInputSchema } from "./create.schema";
import { deleteHandler } from "./delete.handler";
import { duplicateHandler } from "./duplicate.handler";
import { ZScheduleDuplicateSchema } from "./duplicate.schema";
import { updateHandler } from "./update.handler";
import { ZUpdateInputSchema } from "./update.schema";

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../../apps/web/cloudflare.config")).default.worker,
  setupTimeout: 120_000,
});

const hours = (days: number[], startHour = 9, endHour = 17) =>
  Array.from({ length: 7 }, (_, day) =>
    days.includes(day)
      ? [
          {
            start: new Date(Date.UTC(1970, 0, 1, startHour)),
            end: new Date(Date.UTC(1970, 0, 1, endHour)),
          },
        ]
      : []
  );

const createUser = (username: string, timeZone = "Asia/Manila") =>
  prisma.user.create({
    data: { email: `${username}@example.com`, username, name: username, timeZone },
  });

const userContext = async (userId: number) => {
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: userId },
    select: { id: true, timeZone: true, defaultScheduleId: true },
  });
  return { user };
};

const createSchedule = (userId: number, name = "Working hours", timeZone = "Asia/Manila") =>
  prisma.schedule.create({
    data: {
      userId,
      name,
      timeZone,
      availability: {
        createMany: {
          data: [
            {
              days: [1, 2, 3, 4, 5],
              startTime: new Date(Date.UTC(1970, 0, 1, 9)),
              endTime: new Date(Date.UTC(1970, 0, 1, 17)),
            },
          ],
        },
      },
    },
  });

const scheduleRows = (scheduleId: number) =>
  prisma.availability.findMany({
    where: { scheduleId },
    select: { days: true, startTime: true, endTime: true, date: true },
    orderBy: { id: "asc" },
  });

d1.beforeEach(async () => {
  await d1.db.batch([
    d1.db.prepare('DROP TRIGGER IF EXISTS "fail_user_default"'),
    d1.db.prepare('DROP TRIGGER IF EXISTS "fail_schedule_update"'),
    d1.db.prepare('DROP TRIGGER IF EXISTS "fail_schedule_delete"'),
    d1.db.prepare('DROP TRIGGER IF EXISTS "fail_schedule_insert"'),
    d1.db.prepare('DELETE FROM "users"'),
    d1.db.prepare('DELETE FROM "Team"'),
  ]);
});

describe("schedule create on D1", () => {
  d1.it("creates the weekly hours in the user time zone and makes the first schedule default", async () => {
    const user = await createUser("owner");
    const result = await createHandler({
      ctx: await userContext(user.id),
      input: { name: "Work", schedule: hours([1, 2]) },
    });

    expect(result.schedule).toMatchObject({ name: "Work", userId: user.id, timeZone: "Asia/Manila" });
    expect(await scheduleRows(result.schedule.id)).toEqual([
      {
        days: [1, 2],
        startTime: new Date(Date.UTC(1970, 0, 1, 9)),
        endTime: new Date(Date.UTC(1970, 0, 1, 17)),
        date: null,
      },
    ]);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { defaultScheduleId: true } })
    ).toEqual({ defaultScheduleId: result.schedule.id });
  });

  d1.it("denies an event type owned by another user and writes no schedule", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    const eventType = await prisma.eventType.create({
      data: { title: "Other", slug: "other", length: 30, userId: other.id },
    });

    await expect(
      createHandler({ ctx: await userContext(owner.id), input: { name: "Nope", eventTypeId: eventType.id } })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await prisma.schedule.count()).toBe(0);
  });

  d1.it("keeps the created schedule when the later default update fails", async () => {
    const user = await createUser("owner");
    await d1.db
      .prepare(
        `CREATE TRIGGER "fail_user_default" BEFORE UPDATE ON "users"
         BEGIN SELECT RAISE(ABORT, 'forced default failure'); END`
      )
      .run();

    await expect(
      createHandler({ ctx: await userContext(user.id), input: { name: "Work", schedule: hours([1]) } })
    ).rejects.toThrow(/forced default failure/);

    expect(await prisma.schedule.count()).toBe(1);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { defaultScheduleId: true } })
    ).toEqual({ defaultScheduleId: null });
  });

  d1.it("rejects invalid create input at the schema boundary", () => {
    expect(ZCreateInputSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(ZCreateInputSchema.safeParse({ name: "Work", schedule: "bad" }).success).toBe(false);
    expect(ZCreateInputSchema.safeParse({ name: "Work", eventTypeId: "1" }).success).toBe(false);
  });
});

describe("schedule update on D1", () => {
  d1.it(
    "replaces weekly and date-override rows and returns the default and timezone projection",
    async () => {
      const user = await createUser("owner");
      const schedule = await createSchedule(user.id);
      await prisma.user.update({ where: { id: user.id }, data: { defaultScheduleId: schedule.id } });
      const dateOverride = {
        start: new Date(Date.UTC(2026, 10, 10, 10)),
        end: new Date(Date.UTC(2026, 10, 10, 11)),
      };

      const result = await updateHandler({
        ctx: await userContext(user.id),
        input: {
          scheduleId: schedule.id,
          name: "Updated",
          timeZone: "Europe/London",
          schedule: hours([3]),
          dateOverrides: [dateOverride],
        },
      });

      expect(result).toMatchObject({
        timeZone: "Europe/London",
        isDefault: true,
        prevDefaultId: schedule.id,
        currentDefaultId: schedule.id,
      });
      expect(result.schedule).toMatchObject({ id: schedule.id, name: "Updated", timeZone: "Europe/London" });
      expect(await scheduleRows(schedule.id)).toEqual([
        {
          days: [3],
          startTime: new Date(Date.UTC(1970, 0, 1, 9)),
          endTime: new Date(Date.UTC(1970, 0, 1, 17)),
          date: null,
        },
        { days: [], startTime: dateOverride.start, endTime: dateOverride.end, date: dateOverride.start },
      ]);
    }
  );

  d1.it("selects a new default without erasing the submitted schedule availability", async () => {
    const user = await createUser("owner");
    const first = await createSchedule(user.id, "First");
    const second = await createSchedule(user.id, "Second");
    await prisma.user.update({ where: { id: user.id }, data: { defaultScheduleId: first.id } });
    const before = await scheduleRows(second.id);

    const result = await updateHandler({
      ctx: await userContext(user.id),
      input: { scheduleId: second.id, isDefault: true },
    });

    expect(result).toMatchObject({
      schedule: { id: second.id, userId: user.id, name: "Second" },
      isDefault: true,
    });
    expect(await scheduleRows(second.id)).toEqual(before);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { defaultScheduleId: true } })
    ).toEqual({ defaultScheduleId: second.id });
  });

  d1.it("does not clear availability or time zone when the name is omitted", async () => {
    const user = await createUser("owner");
    const schedule = await createSchedule(user.id);
    const before = await scheduleRows(schedule.id);

    await updateHandler({
      ctx: await userContext(user.id),
      input: { scheduleId: schedule.id, timeZone: "Europe/London" },
    });

    expect(await scheduleRows(schedule.id)).toEqual(before);
    expect(
      await prisma.schedule.findUniqueOrThrow({ where: { id: schedule.id }, select: { timeZone: true } })
    ).toEqual({ timeZone: "Asia/Manila" });
  });

  d1.it("denies a missing schedule and a schedule owned by another user", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    const otherSchedule = await createSchedule(other.id);

    await expect(
      updateHandler({ ctx: await userContext(owner.id), input: { scheduleId: 999, name: "Nope" } })
    ).rejects.toMatchObject({ statusCode: 401, message: "Unauthorized" });
    await expect(
      updateHandler({
        ctx: await userContext(owner.id),
        input: { scheduleId: otherSchedule.id, name: "Nope" },
      })
    ).rejects.toMatchObject({ statusCode: 401, message: "Unauthorized" });
  });

  d1.it("rolls back the whole replacement when a later availability insert fails", async () => {
    const user = await createUser("owner");
    const schedule = await createSchedule(user.id);
    const before = await scheduleRows(schedule.id);
    await d1.db
      .prepare(
        `CREATE TRIGGER "fail_schedule_update" BEFORE INSERT ON "Availability"
         WHEN NEW."days" = '[6]' BEGIN SELECT RAISE(ABORT, 'synthetic later constraint failed'); END`
      )
      .run();

    await expect(
      updateHandler({
        ctx: await userContext(user.id),
        input: { scheduleId: schedule.id, name: "Fails", timeZone: "Europe/London", schedule: hours([6]) },
      })
    ).rejects.toMatchObject({ code: ErrorCode.BadRequest });

    expect(await scheduleRows(schedule.id)).toEqual(before);
    expect(
      await prisma.schedule.findUniqueOrThrow({
        where: { id: schedule.id },
        select: { name: true, timeZone: true },
      })
    ).toEqual({ name: "Working hours", timeZone: "Asia/Manila" });
  });

  d1.it("rejects invalid update input at the schema boundary", () => {
    expect(ZUpdateInputSchema.safeParse({ scheduleId: 1, name: "  " }).success).toBe(false);
    expect(ZUpdateInputSchema.safeParse({ scheduleId: 1, timeZone: "Not/AZone" }).success).toBe(false);
    expect(ZUpdateInputSchema.safeParse({ scheduleId: "1" }).success).toBe(false);
  });
});

describe("schedule delete on D1", () => {
  d1.it("moves the default, reassigns hosts and deletes the schedule", async () => {
    const user = await createUser("owner");
    const first = await createSchedule(user.id, "First");
    const second = await createSchedule(user.id, "Second");
    await prisma.user.update({ where: { id: user.id }, data: { defaultScheduleId: first.id } });
    const eventType = await prisma.eventType.create({
      data: {
        title: "Event",
        slug: "event",
        length: 30,
        userId: user.id,
        schedulingType: SchedulingType.COLLECTIVE,
        users: { connect: { id: user.id } },
      },
    });
    await prisma.host.create({
      data: { userId: user.id, eventTypeId: eventType.id, scheduleId: first.id },
    });

    await deleteHandler({
      ctx: { user: (await userContext(user.id)).user },
      input: { scheduleId: first.id },
    });

    expect(await prisma.schedule.count()).toBe(1);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { defaultScheduleId: true } })
    ).toEqual({ defaultScheduleId: second.id });
    expect(await prisma.host.findFirstOrThrow({ select: { scheduleId: true } })).toEqual({
      scheduleId: second.id,
    });
  });

  d1.it("denies another user's schedule and the last remaining schedule", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    const otherSchedule = await createSchedule(other.id);
    const onlySchedule = await createSchedule(owner.id);
    await prisma.user.update({ where: { id: owner.id }, data: { defaultScheduleId: onlySchedule.id } });

    await expect(
      deleteHandler({
        ctx: { user: (await userContext(owner.id)).user },
        input: { scheduleId: otherSchedule.id },
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      deleteHandler({
        ctx: { user: (await userContext(owner.id)).user },
        input: { scheduleId: onlySchedule.id },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    expect(await prisma.schedule.count({ where: { userId: owner.id } })).toBe(1);
  });

  d1.it("keeps the schedule and the new default when the final delete fails", async () => {
    const user = await createUser("owner");
    const first = await createSchedule(user.id, "First");
    await createSchedule(user.id, "Second");
    await prisma.user.update({ where: { id: user.id }, data: { defaultScheduleId: first.id } });
    await d1.db
      .prepare(
        `CREATE TRIGGER "fail_schedule_delete" BEFORE DELETE ON "Schedule"
         BEGIN SELECT RAISE(ABORT, 'forced delete failure'); END`
      )
      .run();

    await expect(
      deleteHandler({ ctx: { user: (await userContext(user.id)).user }, input: { scheduleId: first.id } })
    ).rejects.toThrow(/forced delete failure/);

    expect(await prisma.schedule.count()).toBe(2);
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id }, select: { defaultScheduleId: true } })
    ).not.toEqual({ defaultScheduleId: first.id });
  });
});

describe("schedule duplicate on D1", () => {
  d1.it("copies the weekly rows, date overrides and fallback time zone", async () => {
    const user = await createUser("owner");
    const schedule = await createSchedule(user.id, "Original", "Europe/London");
    const dateOverride = {
      start: new Date(Date.UTC(2026, 10, 10, 10)),
      end: new Date(Date.UTC(2026, 10, 10, 11)),
    };
    await prisma.availability.create({
      data: {
        scheduleId: schedule.id,
        days: [],
        startTime: dateOverride.start,
        endTime: dateOverride.end,
        date: dateOverride.start,
      },
    });

    const result = await duplicateHandler({
      ctx: { user: { id: user.id, timeZone: "Asia/Manila" } },
      input: { scheduleId: schedule.id },
    });

    expect(result.schedule).toMatchObject({
      name: "Original (Copy)",
      userId: user.id,
      timeZone: "Europe/London",
    });
    expect(await scheduleRows(result.schedule.id)).toEqual(await scheduleRows(schedule.id));
  });

  d1.it("rejects invalid duplicate input at the schema boundary", () => {
    expect(ZScheduleDuplicateSchema.safeParse({ scheduleId: "1" }).success).toBe(false);
    expect(ZScheduleDuplicateSchema.safeParse({}).success).toBe(false);
    expect(ZScheduleDuplicateSchema.safeParse({ scheduleId: 1 }).success).toBe(true);
  });

  d1.it("denies another user's schedule through the source catch-all", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    const otherSchedule = await createSchedule(other.id);

    await expect(
      duplicateHandler({
        ctx: { user: { id: owner.id, timeZone: "Asia/Manila" } },
        input: { scheduleId: otherSchedule.id },
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await prisma.schedule.count()).toBe(1);
  });

  d1.it("keeps no copy when the create write fails", async () => {
    const user = await createUser("owner");
    const schedule = await createSchedule(user.id);
    await d1.db
      .prepare(
        `CREATE TRIGGER "fail_schedule_insert" BEFORE INSERT ON "Schedule"
         BEGIN SELECT RAISE(ABORT, 'forced insert failure'); END`
      )
      .run();

    await expect(
      duplicateHandler({
        ctx: { user: { id: user.id, timeZone: "Asia/Manila" } },
        input: { scheduleId: schedule.id },
      })
    ).rejects.toMatchObject({ code: "INTERNAL_SERVER_ERROR" });
    expect(await prisma.schedule.count()).toBe(1);
  });
});
