import { prisma } from "@calcom/prisma";
import type { EventType, User } from "@calcom/prisma/client";
import { SchedulingType } from "@calcom/prisma/enums";
import { Frequency } from "@calcom/prisma/zod-utils";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { createCallerFactory } from "@calcom/trpc/server/trpc";
import { describe, expect, vi, it as vitestIt } from "vitest";
import { eventTypesRouter } from "./_router";
import { eventTypesRouter as heavyEventTypesRouter } from "./heavy/_router";
import { createHandler } from "./heavy/create.handler";
import { ZCreateInputSchema } from "./heavy/create.schema";
import { duplicateHandler } from "./heavy/duplicate.handler";
import { updateHandler } from "./heavy/update.handler";
import { ZUpdateInputSchema } from "./types";

const sessionUser = vi.hoisted(() => ({ value: null as { id: number } | null }));

vi.mock("@calcom/features/auth/lib/userFromSessionUtils", () => ({
  getUserSession: async () => ({ user: sessionUser.value, session: sessionUser.value ? {} : null }),
}));

type CreateContext = Parameters<typeof createHandler>[0]["ctx"];
type UpdateContext = Parameters<typeof updateHandler>[0]["ctx"];

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../apps/web/cloudflare.config")).default.worker,
  setupTimeout: 120_000,
});
const it = d1.it;

const callerContext = { prisma } as unknown as Parameters<
  ReturnType<typeof createCallerFactory<typeof eventTypesRouter>>
>[0];
const caller = createCallerFactory(eventTypesRouter)(callerContext);
const heavyCaller = createCallerFactory(heavyEventTypesRouter)(callerContext);

const createUser = (username: string) =>
  prisma.user.create({
    data: { email: `${username}@example.com`, username, name: username, timeZone: "Asia/Manila" },
  });

const createEventType = (userId: number, overrides: Partial<EventType> = {}) =>
  prisma.eventType.create({
    data: {
      title: "Intro",
      slug: "intro",
      length: 30,
      userId,
      ...overrides,
      users: { connect: { id: userId } },
    },
  });

const createSchedule = (userId: number) =>
  prisma.schedule.create({
    data: {
      userId,
      name: "Working hours",
      timeZone: "Asia/Manila",
      availability: {
        createMany: {
          data: [
            {
              days: [1, 2, 3, 4, 5],
              startTime: new Date("1970-01-01T09:00:00.000Z"),
              endTime: new Date("1970-01-01T17:00:00.000Z"),
            },
          ],
        },
      },
    },
  });

const createTeam = (slug: string) => prisma.team.create({ data: { name: slug, slug } });
const addMembership = (teamId: number, userId: number, role: "OWNER" | "MEMBER", accepted = true) =>
  prisma.membership.create({ data: { teamId, userId, role, accepted } });
const eventTitle = (id: number) => prisma.eventType.findUnique({ where: { id }, select: { title: true } });

const createContext = (user: User): CreateContext => ({
  user: {
    id: user.id,
    role: "USER",
    organizationId: null,
    organization: { isOrgAdmin: false },
    profile: { id: null },
    metadata: null,
    email: user.email,
  },
  prisma,
});

const updateContext = (user: User): UpdateContext => ({
  user: {
    id: user.id,
    username: user.username ?? "",
    profile: { id: null },
    userLevelSelectedCalendars: [],
    organizationId: null,
    email: user.email,
    locale: "en",
  },
  prisma,
});

const duplicateContext = (user: User) =>
  ({ user: { id: user.id } }) as unknown as Parameters<typeof duplicateHandler>[0]["ctx"];

d1.beforeEach(async () => {
  sessionUser.value = null;
  await d1.db.batch([d1.db.prepare('DELETE FROM "users"'), d1.db.prepare('DELETE FROM "Team"')]);
});

describe("event type create on D1", () => {
  it("creates a personal event type with its owner, locations and scheduling shape", async () => {
    const user = await createUser("owner");
    const result = await createHandler({
      ctx: createContext(user),
      input: {
        title: "Intro",
        slug: "intro",
        length: 30,
        locations: [{ type: "inPerson", address: "Office" }],
      },
    });

    expect(result.eventType).toMatchObject({
      title: "Intro",
      slug: "intro",
      length: 30,
      userId: user.id,
      locations: [{ type: "inPerson", address: "Office" }],
    });
    expect(
      await prisma.eventType.findUnique({
        where: { id: result.eventType.id },
        select: { userId: true, schedulingType: true, users: { select: { id: true } } },
      })
    ).toEqual({ userId: user.id, schedulingType: null, users: [{ id: user.id }] });
  });

  it("creates a team event with the team scheduling type and no personal owner", async () => {
    const user = await createUser("owner");
    const team = await createTeam("team");
    const result = await createHandler({
      ctx: createContext(user),
      input: {
        title: "Team intro",
        slug: "team-intro",
        length: 30,
        teamId: team.id,
        schedulingType: SchedulingType.ROUND_ROBIN,
        locations: [],
      },
    });

    expect(result.eventType).toMatchObject({
      userId: null,
      teamId: team.id,
      schedulingType: SchedulingType.ROUND_ROBIN,
    });
  });

  it("maps a duplicate slug to BAD_REQUEST and leaves the existing event intact", async () => {
    const user = await createUser("owner");
    await createEventType(user.id, { slug: "taken" });

    await expect(
      createHandler({
        ctx: createContext(user),
        input: { title: "Second", slug: "taken", length: 30, locations: [] },
      })
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: "URL Slug already exists for given user.",
    });

    expect(await prisma.eventType.count()).toBe(1);
    expect(await eventTitle((await prisma.eventType.findFirstOrThrow()).id)).toEqual({ title: "Intro" });
  });

  it("denies an unauthenticated create through the router without writing the event", async () => {
    sessionUser.value = null;
    await expect(
      heavyCaller.create({ title: "Locked", slug: "locked", length: 30, locations: [] })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await prisma.eventType.count()).toBe(0);
  });

  it("rejects invalid create input at the schema boundary", () => {
    expect(ZCreateInputSchema.safeParse({ title: "  ", slug: "intro", length: 30 }).success).toBe(false);
    expect(
      ZCreateInputSchema.safeParse({ title: "Intro", slug: "intro", length: 30, teamId: 1 }).success
    ).toBe(false);
    expect(ZCreateInputSchema.safeParse({ title: "Intro", slug: "My Event", length: 30 })).toMatchObject({
      success: true,
      data: { slug: "my-event" },
    });
  });
});

describe("event type update on D1", () => {
  it("writes the event, schedule, custom questions, private links and payment metadata", async () => {
    const user = await createUser("owner");
    const schedule = await createSchedule(user.id);
    const eventType = await createEventType(user.id);
    const question = await prisma.eventTypeCustomInput.create({
      data: { eventTypeId: eventType.id, label: "Old", type: "TEXT", required: false, placeholder: "" },
    });

    const result = await updateHandler({
      ctx: updateContext(user),
      input: {
        id: eventType.id,
        title: "Updated",
        slug: "updated",
        description: "Updated description",
        locations: [{ type: "inPerson", address: "New office" }],
        schedule: schedule.id,
        customInputs: [
          {
            id: question.id,
            eventTypeId: eventType.id,
            label: "Updated question",
            type: "TEXT",
            required: true,
            placeholder: "Answer",
          },
          {
            id: -1,
            eventTypeId: eventType.id,
            label: "New question",
            type: "TEXT",
            required: false,
            placeholder: "",
            hasToBeCreated: true,
          },
        ],
        multiplePrivateLinks: ["private-one", "private-two"],
        metadata: { apps: { stripe: { enabled: true, price: 5000, currency: "USD" } } },
      },
    });

    expect(result.eventType).toMatchObject({ title: "Intro", description: null });
    expect(
      await prisma.eventType.findUnique({
        where: { id: eventType.id },
        select: {
          title: true,
          slug: true,
          description: true,
          locations: true,
          scheduleId: true,
          price: true,
          currency: true,
          customInputs: { select: { label: true, required: true }, orderBy: { id: "asc" } },
          hashedLink: { select: { link: true }, orderBy: { id: "asc" } },
        },
      })
    ).toEqual({
      title: "Updated",
      slug: "updated",
      description: "Updated description",
      locations: [{ type: "inPerson", address: "New office" }],
      scheduleId: schedule.id,
      price: 5000,
      currency: "USD",
      customInputs: [
        { label: "Updated question", required: true },
        { label: "New question", required: false },
      ],
      hashedLink: [{ link: "private-one" }, { link: "private-two" }],
    });

    const other = await createUser("other");
    const otherSchedule = await createSchedule(other.id);
    await updateHandler({
      ctx: updateContext(user),
      input: { id: eventType.id, schedule: otherSchedule.id },
    });
    expect(
      await prisma.eventType.findUnique({ where: { id: eventType.id }, select: { scheduleId: true } })
    ).toEqual({ scheduleId: schedule.id });
  });

  it("writes a host group and per-host location, then removes a cleared location", async () => {
    const owner = await createUser("owner");
    const team = await createTeam("host-team");
    await addMembership(team.id, owner.id, "OWNER");
    const eventType = await createEventType(owner.id, {
      teamId: team.id,
      userId: null,
      schedulingType: SchedulingType.ROUND_ROBIN,
    });
    const groupId = crypto.randomUUID();
    const location = { eventTypeId: eventType.id, userId: owner.id, type: "inPerson", address: "HQ" };

    await updateHandler({
      ctx: updateContext(owner),
      input: {
        id: eventType.id,
        hostGroups: [{ id: groupId, name: "Group" }],
        hosts: [{ userId: owner.id, groupId, location }],
      },
    });

    expect(
      await prisma.host.findMany({
        where: { eventTypeId: eventType.id },
        select: { priority: true, weight: true, groupId: true, location: { select: { address: true } } },
      })
    ).toEqual([{ priority: 2, weight: 100, groupId, location: { address: "HQ" } }]);
    expect(await prisma.hostGroup.findMany({ select: { id: true, name: true } })).toEqual([
      { id: groupId, name: "Group" },
    ]);

    await updateHandler({
      ctx: updateContext(owner),
      input: { id: eventType.id, hosts: [{ userId: owner.id, groupId, location: null }] },
    });
    expect(await prisma.hostLocation.count()).toBe(0);
  });

  it("denies cross-team ids, unowned restriction schedules and unaccepted hosts before writing", async () => {
    const owner = await createUser("owner");
    const other = await createUser("other");
    const eventTeam = await createTeam("event-team");
    const otherTeam = await createTeam("other-team");
    const hostTeam = await createTeam("host-team");
    await addMembership(hostTeam.id, owner.id, "OWNER");
    const otherSchedule = await createSchedule(other.id);
    const teamEvent = await createEventType(owner.id, { teamId: eventTeam.id, userId: null });
    const personal = await createEventType(owner.id, { slug: "personal" });
    const hostEvent = await createEventType(owner.id, {
      slug: "host-event",
      teamId: hostTeam.id,
      userId: null,
      schedulingType: SchedulingType.ROUND_ROBIN,
    });

    await expect(
      updateHandler({
        ctx: updateContext(owner),
        input: { id: teamEvent.id, teamId: otherTeam.id, title: "Nope" },
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect(await eventTitle(teamEvent.id)).toEqual({ title: "Intro" });

    await expect(
      updateHandler({
        ctx: updateContext(owner),
        input: { id: personal.id, restrictionScheduleId: otherSchedule.id },
      })
    ).rejects.toMatchObject({
      code: "UNAUTHORIZED",
      message: "The restriction schedule is not owned by you or your team",
    });

    await expect(
      updateHandler({ ctx: updateContext(owner), input: { id: hostEvent.id, hosts: [{ userId: other.id }] } })
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.host.count({ where: { eventTypeId: hostEvent.id } })).toBe(0);
  });

  vitestIt.each([
    [
      "seats with recurrence",
      { seatsPerTimeSlot: 2, recurringEvent: { interval: 1, count: 12, freq: Frequency.WEEKLY } },
      "Recurring Events and Offer Seats cannot be active at the same time.",
    ],
    [
      "descending booking limits",
      { bookingLimits: { PER_WEEK: 2, PER_DAY: 3 } },
      "Booking limits must be in ascending order.",
    ],
    [
      "descending duration limits",
      { durationLimits: { PER_WEEK: 2, PER_DAY: 3 } },
      "Duration limits must be in ascending order.",
    ],
    [
      "non-positive booker limit",
      { maxActiveBookingsPerBooker: -1 },
      "Booker booking limit must be greater than 0.",
    ],
    ["negative offset", { offsetStart: -1 }, "Offset start time must be zero or greater."],
    [
      "invalid booker layouts",
      { metadata: { bookerLayouts: { enabledLayouts: ["month_view"], defaultLayout: "week_view" } } },
      undefined,
    ],
  ])("rejects $0 before writing the event", (name, input, message) =>
    d1.run(async () => {
      const owner = await createUser("owner");
      const eventType = await createEventType(owner.id);
      await expect(
        updateHandler({ ctx: updateContext(owner), input: { id: eventType.id, ...input } })
      ).rejects.toMatchObject(message ? { code: "BAD_REQUEST", message } : { code: "BAD_REQUEST" });
      expect(await eventTitle(eventType.id)).toEqual({ title: "Intro" });
    })
  );

  it("keeps earlier private-link writes when the final event update conflicts", async () => {
    const owner = await createUser("owner");
    await createEventType(owner.id, { slug: "taken" });
    const eventType = await createEventType(owner.id, { slug: "free" });

    await expect(
      updateHandler({
        ctx: updateContext(owner),
        input: { id: eventType.id, slug: "taken", multiplePrivateLinks: ["survives-conflict"] },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "error_event_type_url_duplicate" });

    expect(
      await prisma.eventType.findUnique({ where: { id: eventType.id }, select: { slug: true } })
    ).toEqual({ slug: "free" });
    expect(await prisma.hashedLink.findMany({ select: { link: true } })).toEqual([
      { link: "survives-conflict" },
    ]);
  });

  it("fails for a missing event and rejects unknown update fields", async () => {
    const owner = await createUser("owner");
    await expect(
      updateHandler({ ctx: updateContext(owner), input: { id: 999, title: "Missing" } })
    ).rejects.toMatchObject({ code: "P2025" });
    expect(ZUpdateInputSchema.safeParse({ id: 1, unknownField: true }).success).toBe(false);
    expect(ZUpdateInputSchema.safeParse({ id: 1, seatsPerTimeSlot: 0 }).success).toBe(false);
  });
});

describe("event type duplicate on D1", () => {
  it("copies the event, its custom questions and its private link under the requested slug", async () => {
    const owner = await createUser("owner");
    const eventType = await createEventType(owner.id);
    await prisma.eventTypeCustomInput.create({
      data: { eventTypeId: eventType.id, label: "Question", type: "TEXT", required: true, placeholder: "" },
    });
    await prisma.hashedLink.create({ data: { eventTypeId: eventType.id, link: "original-link" } });

    const result = await duplicateHandler({
      ctx: duplicateContext(owner),
      input: { id: eventType.id, slug: "copy", title: "Copy", description: "Copied", length: 45 },
    });

    expect(result.eventType).toMatchObject({
      slug: "copy",
      title: "Copy",
      description: "Copied",
      length: 45,
      userId: owner.id,
    });
    expect(
      await prisma.eventType.findUnique({
        where: { id: result.eventType.id },
        select: { customInputs: { select: { label: true } }, hashedLink: { select: { link: true } } },
      })
    ).toEqual({ customInputs: [{ label: "Question" }], hashedLink: [{ link: expect.any(String) }] });
    expect(await prisma.eventType.count()).toBe(2);

    await expect(
      duplicateHandler({
        ctx: duplicateContext(owner),
        input: { id: eventType.id, slug: "intro", title: "Copy", description: "", length: 30 },
      })
    ).rejects.toMatchObject({ code: "CONFLICT", message: "duplicate_event_slug_conflict" });
    expect(await prisma.eventType.count()).toBe(2);
  });

  it("denies a team outsider before creating the copy", async () => {
    const owner = await createUser("owner");
    const outsider = await createUser("outsider");
    const team = await createTeam("team");
    await addMembership(team.id, owner.id, "OWNER");
    const eventType = await createEventType(owner.id, {
      teamId: team.id,
      schedulingType: SchedulingType.COLLECTIVE,
    });

    await expect(
      duplicateHandler({
        ctx: duplicateContext(outsider),
        input: { id: eventType.id, slug: "copy", title: "Copy", description: "", length: 30 },
      })
    ).rejects.toMatchObject({
      code: "INTERNAL_SERVER_ERROR",
      message: expect.stringContaining("FORBIDDEN"),
    });
    expect(await prisma.eventType.count()).toBe(1);
  });
});

describe("managed event types on D1", () => {
  it("keeps parent and child rows distinct and does not propagate a parent update", async () => {
    const owner = await createUser("owner");
    const team = await createTeam("team");
    const parent = await createEventType(owner.id, {
      slug: "managed",
      title: "Managed",
      teamId: team.id,
      schedulingType: SchedulingType.MANAGED,
    });
    const child = await createEventType(owner.id, {
      slug: "managed-child",
      title: "Child",
      parentId: parent.id,
    });

    await updateHandler({
      ctx: updateContext(owner),
      input: { id: parent.id, title: "Managed updated", children: [] },
    });

    expect(parent.id).not.toBe(child.id);
    expect(await eventTitle(parent.id)).toEqual({ title: "Managed updated" });
    expect(
      await prisma.eventType.findUnique({
        where: { id: child.id },
        select: { title: true, parentId: true, userId: true },
      })
    ).toEqual({ title: "Child", parentId: parent.id, userId: owner.id });
  });
});

describe("event type delete on D1", () => {
  it("deletes the event and its relations for the owner", async () => {
    const owner = await createUser("owner");
    const eventType = await createEventType(owner.id);
    await prisma.eventTypeCustomInput.create({
      data: { eventTypeId: eventType.id, label: "Question", type: "TEXT", required: false, placeholder: "" },
    });
    await prisma.hashedLink.create({ data: { eventTypeId: eventType.id, link: "private" } });
    await prisma.calVideoSettings.create({ data: { eventTypeId: eventType.id } });

    sessionUser.value = { id: owner.id };
    await expect(caller.delete({ id: eventType.id })).resolves.toEqual({ id: eventType.id });
    expect(await prisma.eventType.count()).toBe(0);
    expect(await prisma.eventTypeCustomInput.count()).toBe(0);
    expect(await prisma.hashedLink.count()).toBe(0);
    expect(await prisma.calVideoSettings.count()).toBe(0);
  });

  it("denies a non-owner delete and leaves every relation intact", async () => {
    const owner = await createUser("owner");
    const outsider = await createUser("outsider");
    const eventType = await createEventType(owner.id);
    await prisma.hashedLink.create({ data: { eventTypeId: eventType.id, link: "private" } });

    sessionUser.value = { id: outsider.id };
    await expect(caller.delete({ id: eventType.id })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect(await prisma.eventType.count()).toBe(1);
    expect(await prisma.hashedLink.count()).toBe(1);
  });

  it("fails for a missing event without deleting unrelated rows", async () => {
    const owner = await createUser("owner");
    await createEventType(owner.id);
    sessionUser.value = { id: owner.id };
    await expect(caller.delete({ id: 999 })).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(await prisma.eventType.count()).toBe(1);
  });
});
