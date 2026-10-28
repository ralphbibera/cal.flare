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
async function seed() {
  assert.equal(await db.credential.count(), 0, "Reference database must not contain provider credentials");
  assert.equal(await db.booking.count(), 0, "Reference database must not contain bookings");
  assert.equal(await db.user.count({ where: { email: { not: "organizer@reference.invalid" } } }), 0);
  const identity = {
    username: "reference",
    name: "Organizer",
    email: "organizer@reference.invalid",
    emailVerified: new Date("2026-01-01T00:00:00Z"),
    completedOnboarding: true,
    timeZone: "UTC",
    locale: "en",
  };
  const owner = await db.user.upsert({
    where: { email: "organizer@reference.invalid" },
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
  console.log(JSON.stringify({ ownerId: owner.id, eventId: event.id, path: "/reference/intro" }));
}
seed()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
