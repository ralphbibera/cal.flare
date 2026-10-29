const assert = require("node:assert/strict");
const { createRequire } = require("node:module");
const { join } = require("node:path");
const root = process.env.CALFLARE_REFERENCE_ROOT;
const load = createRequire(join(root, "package.json"));
load("ts-node").register({
  transpileOnly: true,
  skipProject: true,
  compilerOptions: { module: "CommonJS", moduleResolution: "Node", target: "ES2022" },
});
const { PrismaClient } = load(join(root, "packages/prisma/generated/prisma/client.ts"));
const { PrismaPg } = load("@prisma/adapter-pg");
const db = new PrismaClient({
  adapter: new PrismaPg({
    connectionString: "postgresql://calflare_reference@127.0.0.1:18796/calflare_reference",
  }),
});
const confirmationUid = "calflare-confirmation-reference-20300110";
const confirmationEmail = "confirmation-organizer@reference.invalid";
const attendee = {
  name: "Primary Attendee",
  email: "primary@example.invalid",
  timeZone: "UTC",
  locale: "en",
};
const booking = {
  uid: confirmationUid,
  title: "Intro call between Organizer and Primary Attendee",
  description: "Synthetic confirmation fixture.",
  userPrimaryEmail: confirmationEmail,
  startTime: new Date("2030-01-10T09:00:00Z"),
  endTime: new Date("2030-01-10T09:30:00Z"),
  status: "ACCEPTED",
  location: null,
  recurringEventId: null,
  fromReschedule: null,
  rescheduled: null,
  scheduledJobs: [],
  paid: false,
  cancelledBy: null,
  rescheduledBy: null,
  smsReminderNumber: null,
};
const confirmationEvent = {
  slug: "intro",
  title: "Intro call",
  length: 30,
  locations: [],
  requiresConfirmation: false,
  disableCancelling: false,
  disableRescheduling: false,
  recurringEvent: null,
  hideOrganizerEmail: false,
  seatsPerTimeSlot: null,
  eventName: null,
  metadata: null,
  schedulingType: null,
  teamId: null,
  parentId: null,
};

async function seed(db) {
  assert.equal(await db.credential.count(), 0, "Reference database must not contain provider credentials");
  assert.equal(
    await db.user.count({ where: { email: { notIn: ["organizer@reference.invalid", confirmationEmail] } } }),
    0
  );
  const known = await db.booking.findMany({
    select: {
      ...Object.fromEntries(Object.keys(booking).map((key) => [key, true])),
      user: { select: { email: true, username: true, name: true, timeZone: true } },
      eventType: {
        select: {
          ...Object.fromEntries(Object.keys(confirmationEvent).map((key) => [key, true])),
          owner: { select: { email: true } },
          users: { select: { email: true } },
        },
      },
      attendees: {
        select: { ...Object.fromEntries(Object.keys(attendee).map((key) => [key, true])), phoneNumber: true },
      },
      responses: true,
      customInputs: true,
      metadata: true,
      cancellationReason: true,
      rejectionReason: true,
      destinationCalendarId: true,
      tracking: { select: { id: true } },
      assignmentReason: { select: { id: true } },
      _count: { select: { references: true, payment: true, seatsReferences: true, scheduledTriggers: true } },
    },
  });
  assert.ok(known.length <= 1, "Only the exact isolated confirmation booking is allowed");
  if (known.length) {
    assert.deepEqual(
      known[0],
      {
        ...booking,
        user: {
          email: confirmationEmail,
          username: "confirmation-reference",
          name: "Organizer",
          timeZone: "UTC",
        },
        eventType: {
          ...confirmationEvent,
          owner: { email: confirmationEmail },
          users: [{ email: confirmationEmail }],
        },
        attendees: [{ ...attendee, phoneNumber: null }],
        responses: null,
        customInputs: null,
        metadata: null,
        cancellationReason: null,
        rejectionReason: null,
        destinationCalendarId: null,
        tracking: null,
        assignmentReason: [],
        _count: { references: 0, payment: 0, seatsReferences: 0, scheduledTriggers: 0 },
      },
      "Unknown or changed booking data must fail before writes"
    );
  }
  const main = await seedOrganizer(db, "organizer@reference.invalid", "reference");
  const confirmation = await seedOrganizer(db, confirmationEmail, "confirmation-reference");
  if (!known.length) {
    await db.booking.create({
      data: {
        ...booking,
        userId: confirmation.ownerId,
        eventTypeId: confirmation.eventId,
        attendees: { create: attendee },
      },
      select: { id: true },
    });
  }
  assert.equal(await db.booking.count({ where: { userId: main.ownerId } }), 0);
  return {
    ...main,
    confirmationUid,
    counts: {
      users: await db.user.count(),
      events: await db.eventType.count(),
      schedules: await db.schedule.count(),
      attendees: await db.attendee.count(),
      bookings: await db.booking.count(),
      credentials: await db.credential.count(),
    },
  };
}

async function seedOrganizer(db, email, username) {
  const previous = await db.user.findUnique({
    where: { email },
    select: { username: true, defaultScheduleId: true, id: true },
  });
  if (previous) {
    assert.equal(previous.username, username, "Unknown organizer identity");
    if (previous.defaultScheduleId) {
      assert.equal(
        await db.schedule.count({ where: { id: previous.defaultScheduleId, userId: previous.id } }),
        1
      );
    }
    const events = await db.eventType.findMany({
      where: { userId: previous.id },
      select: {
        ...Object.fromEntries(Object.keys(confirmationEvent).map((key) => [key, true])),
        scheduleId: true,
        users: { select: { email: true } },
      },
    });
    assert.ok(events.length <= 1, "Only the known organizer event is allowed");
    if (events.length) {
      assert.deepEqual(
        events[0],
        {
          ...confirmationEvent,
          scheduleId: previous.defaultScheduleId,
          users: [{ email }],
        },
        "Fixture organizers must not share event hosts or schedules"
      );
    }
  }
  const identity = {
    username,
    name: "Organizer",
    email,
    emailVerified: new Date("2026-01-01T00:00:00Z"),
    completedOnboarding: true,
    timeZone: "UTC",
    locale: "en",
  };
  const owner = await db.user.upsert({
    where: { email },
    update: identity,
    create: identity,
    select: { id: true, defaultScheduleId: true },
  });
  const hours = {
    name: "Reference hours",
    timeZone: "UTC",
    availability: {
      create: [
        {
          days: [0, 1, 2, 3, 4, 5, 6],
          startTime: new Date("1970-01-01T09:00:00Z"),
          endTime: new Date("1970-01-01T17:00:00Z"),
        },
      ],
    },
  };
  const schedule = owner.defaultScheduleId
    ? await db.schedule.update({
        where: { id: owner.defaultScheduleId },
        data: { ...hours, availability: { deleteMany: {}, ...hours.availability } },
        select: { id: true },
      })
    : await db.schedule.create({ data: { ...hours, userId: owner.id }, select: { id: true } });
  await db.user.update({
    where: { id: owner.id },
    data: { defaultScheduleId: schedule.id },
    select: { id: true },
  });
  const data = {
    title: "Intro call",
    slug: "intro",
    description: "A short conversation.",
    length: 30,
    minimumBookingNotice: 0,
    slotInterval: 30,
    userId: owner.id,
    users: { connect: [{ id: owner.id }] },
    scheduleId: schedule.id,
    locations: [],
  };
  const existing = await db.eventType.findFirst({
    where: { userId: owner.id, slug: "intro" },
    select: { id: true },
  });
  const event = existing
    ? await db.eventType.update({ where: { id: existing.id }, data, select: { id: true } })
    : await db.eventType.create({ data, select: { id: true } });
  await db.selectedSlots.deleteMany({ where: { eventTypeId: event.id, userId: owner.id } });
  return { ownerId: owner.id, eventId: event.id, path: `/${username}/intro` };
}
db.$transaction(seed, { timeout: 30000 })
  .then((result) => console.log(JSON.stringify(result)))
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
