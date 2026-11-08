import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BookingRepository } from "@calcom/features/bookings/repositories/BookingRepository";
import { PrismaBookingAttendeeRepository } from "@calcom/features/bookings/repositories/PrismaBookingAttendeeRepository";
import { prisma } from "@calcom/prisma";
import { withD1Database } from "@calcom/prisma/d1";
import { BookingStatus, CreationSource } from "@calcom/prisma/enums";
import { migrateD1 } from "@calcom/prisma/migrate-d1.mjs";
import { Miniflare } from "miniflare";
import { afterAll, beforeAll, beforeEach, describe, expect, vi, it as vitestIt } from "vitest";

let directory: string;
let mf: Miniflare;
let db: Awaited<ReturnType<Miniflare["getD1Database"]>>;
const inD1 = <T>(callback: () => T) => withD1Database({ DB: db }, callback);
const it = (name: string, callback: () => unknown) => vitestIt(name, () => inD1(callback));
const d1BeforeAll = (callback: () => unknown, timeout?: number) => beforeAll(() => inD1(callback), timeout);
const d1AfterAll = (callback: () => unknown, timeout?: number) => afterAll(() => inD1(callback), timeout);

beforeAll(async () => {
  directory = await mkdtemp(join(tmpdir(), "calflare-remove-attendee-"));
  const persistTo = join(directory, "state");
  await migrateD1({ persistTo });
  const { worker } = (await import("../../../../apps/web/cloudflare.config")).default;
  mf = new Miniflare({
    cf: false,
    enableDevRegistry: false,
    telemetry: { enabled: false },
    resourcePersistencePath: join(persistTo, "v3"),
    workers: [
      {
        config: {
          name: worker.name,
          compatibilityDate: worker.compatibilityDate,
          compatibilityFlags: worker.compatibilityFlags,
          env: { DB: worker.env.DB },
          manifest: {
            mainModule: "worker.js",
            modules: {
              "worker.js": { type: "esm", contents: "export default {fetch(){return new Response()}}" },
            },
          },
        },
      },
    ],
  });
  db = await mf.getD1Database("DB");
}, 30_000);

afterAll(async () => {
  await mf?.dispose();
  if (directory) await rm(directory, { recursive: true, force: true });
});

const mockUpdateCalendarAttendees = vi.fn().mockResolvedValue({});
vi.mock("@calcom/features/bookings/lib/EventManager", () => ({
  default: class MockEventManager {
    updateCalendarAttendees = mockUpdateCalendarAttendees;
  },
}));

const mockSendEmail = vi.fn().mockResolvedValue(undefined);
vi.mock("@calcom/emails/templates/attendee-cancelled-email", () => ({
  default: class MockAttendeeCancelledEmail {
    constructor() {}
    sendEmail = mockSendEmail;
  },
}));

vi.mock("@calcom/trpc/server/routers/viewer/bookings/addGuests.handler", async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return {
    ...actual,
    validateUserPermissions: vi.fn().mockResolvedValue(undefined),
    updateCalendarEvent: vi.fn().mockResolvedValue(undefined),
  };
});

import type { BookingAttendeesRemoveServiceDeps } from "./BookingAttendeesRemoveService";
import { BookingAttendeesRemoveService } from "./BookingAttendeesRemoveService";

const createdBookingIds: number[] = [];
const createdUserIds: number[] = [];
const createdEventTypeIds: number[] = [];

describe("BookingAttendeesRemoveService.removeAttendee (Integration Tests)", () => {
  const timestamp = Date.now();
  const bookingRepo = new BookingRepository(prisma);
  const service = new BookingAttendeesRemoveService({
    bookingAttendeeRepository: new PrismaBookingAttendeeRepository(prisma),
  });

  let organizerId: number;
  let bookingId: number;
  let primaryAttendeeId: number;
  let secondaryAttendeeId: number;

  const testUser = {
    id: 0,
    email: "",
    organizationId: null as number | null,
    uuid: `test-uuid-${timestamp}`,
  };

  d1BeforeAll(async () => {
    const organizer = await prisma.user.create({
      data: {
        email: `attendee-svc-organizer-${timestamp}@test.com`,
        username: `attendee-svc-organizer-${timestamp}`,
        name: "Test Organizer",
        timeZone: "UTC",
        locale: "en",
        creationSource: CreationSource.WEBAPP,
        schedules: {
          create: {
            name: "Default Schedule",
            timeZone: "UTC",
            availability: {
              create: [
                {
                  days: [0, 1, 2, 3, 4, 5, 6],
                  startTime: new Date("1970-01-01T09:00:00.000Z"),
                  endTime: new Date("1970-01-01T17:00:00.000Z"),
                },
              ],
            },
          },
        },
      },
      select: { id: true, email: true },
    });
    organizerId = organizer.id;
    createdUserIds.push(organizer.id);

    testUser.id = organizer.id;
    testUser.email = organizer.email;

    const eventType = await prisma.eventType.create({
      data: {
        title: `attendee-svc-event-${timestamp}`,
        slug: `attendee-svc-event-${timestamp}`,
        length: 30,
        userId: organizerId,
      },
      select: { id: true },
    });
    createdEventTypeIds.push(eventType.id);

    const booking = await bookingRepo.createBookingForManagedEventReassignment({
      uid: `attendee-svc-booking-${timestamp}`,
      userId: organizerId,
      userPrimaryEmail: organizer.email,
      eventTypeId: eventType.id,
      title: `Attendee Service Test Booking ${timestamp}`,
      description: null,
      startTime: new Date("2030-06-01T10:00:00.000Z"),
      endTime: new Date("2030-06-01T10:30:00.000Z"),
      status: BookingStatus.ACCEPTED,
      location: null,
      smsReminderNumber: null,
      idempotencyKey: `attendee-svc-idempotency-${timestamp}`,
      iCalUID: `attendee-svc-ical-${timestamp}@test.com`,
      iCalSequence: 0,
      attendees: [
        { email: "primary@test.com", name: "Primary Attendee", timeZone: "UTC", locale: "en" },
        {
          email: "secondary@test.com",
          name: "Secondary Attendee",
          timeZone: "America/New_York",
          locale: "en",
        },
      ],
    });
    bookingId = booking.id;
    createdBookingIds.push(booking.id);

    const attendees = await prisma.attendee.findMany({
      where: { bookingId: booking.id },
      orderBy: { id: "asc" },
      select: { id: true, email: true },
    });
    primaryAttendeeId = attendees[0].id;
    secondaryAttendeeId = attendees[1].id;

    await prisma.booking.update({
      where: { id: booking.id },
      data: {
        responses: {
          name: "Primary Attendee",
          email: "primary@test.com",
          guests: ["secondary@test.com"],
        },
      },
    });
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  d1AfterAll(async () => {
    if (createdBookingIds.length > 0) {
      await prisma.attendee.deleteMany({ where: { bookingId: { in: createdBookingIds } } });
      await prisma.booking.deleteMany({ where: { id: { in: createdBookingIds } } });
    }
    if (createdEventTypeIds.length > 0) {
      await prisma.eventType.deleteMany({ where: { id: { in: createdEventTypeIds } } });
    }
    if (createdUserIds.length > 0) {
      await prisma.availability.deleteMany({ where: { Schedule: { userId: { in: createdUserIds } } } });
      await prisma.schedule.deleteMany({ where: { userId: { in: createdUserIds } } });
      await prisma.user.deleteMany({ where: { id: { in: createdUserIds } } });
    }
  });

  it("should remove a secondary attendee, update DB, and emit audit event", async () => {
    const result = await service.removeAttendee({
      bookingId,
      attendeeId: secondaryAttendeeId,
      user: testUser,
      emailsEnabled: true,
    });

    expect(result).toEqual({
      id: secondaryAttendeeId,
      bookingId,
      name: "Secondary Attendee",
      email: "secondary@test.com",
      timeZone: "America/New_York",
    });

    const attendee = await prisma.attendee.findUnique({
      where: { id: secondaryAttendeeId },
    });
    expect(attendee).toBeNull();

    const updatedBooking = await prisma.booking.findUnique({
      where: { id: bookingId },
      select: { responses: true },
    });
    const responses = updatedBooking?.responses as { guests?: string[] } | null;
    expect(responses?.guests ?? []).not.toContain("secondary@test.com");
  });

  describe("primary attendee guard", () => {
    it("should throw when trying to remove the primary attendee", async () => {
      await expect(
        service.removeAttendee({
          bookingId,
          attendeeId: primaryAttendeeId,
          user: testUser,
          emailsEnabled: true,
        })
      ).rejects.toThrow("cannot_remove_primary_attendee");
    });
  });

  describe("non-existent attendee", () => {
    it("should throw when attendee does not exist", async () => {
      await expect(
        service.removeAttendee({
          bookingId,
          attendeeId: 999999,
          user: testUser,
          emailsEnabled: true,
        })
      ).rejects.toThrow("attendee_not_found");
    });
  });

  describe("emails disabled", () => {
    let emailsDisabledBookingId: number;
    let emailsDisabledAttendeeId: number;

    d1BeforeAll(async () => {
      const booking = await bookingRepo.createBookingForManagedEventReassignment({
        uid: `attendee-svc-no-email-${timestamp}`,
        userId: organizerId,
        userPrimaryEmail: testUser.email,
        eventTypeId: createdEventTypeIds[0],
        title: `No Email Test Booking ${timestamp}`,
        description: null,
        startTime: new Date("2030-06-02T10:00:00.000Z"),
        endTime: new Date("2030-06-02T10:30:00.000Z"),
        status: BookingStatus.ACCEPTED,
        location: null,
        smsReminderNumber: null,
        idempotencyKey: `attendee-svc-no-email-idempotency-${timestamp}`,
        iCalUID: `attendee-svc-no-email-ical-${timestamp}@test.com`,
        iCalSequence: 0,
        attendees: [
          { email: "primary-noemail@test.com", name: "Primary", timeZone: "UTC", locale: "en" },
          { email: "secondary-noemail@test.com", name: "Secondary", timeZone: "UTC", locale: "en" },
        ],
      });
      emailsDisabledBookingId = booking.id;
      createdBookingIds.push(booking.id);

      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          responses: {
            name: "Primary",
            email: "primary-noemail@test.com",
            guests: ["secondary-noemail@test.com"],
          },
        },
      });

      const attendees = await prisma.attendee.findMany({
        where: { bookingId: booking.id },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      emailsDisabledAttendeeId = attendees[1].id;
    });

    it("should not send cancellation email when emailsEnabled is false", async () => {
      await service.removeAttendee({
        bookingId: emailsDisabledBookingId,
        attendeeId: emailsDisabledAttendeeId,
        user: testUser,
        emailsEnabled: false,
      });

      expect(mockSendEmail).not.toHaveBeenCalled();
    });
  });

  describe("responses.guests cleanup with plus-addressed email", () => {
    let plusAddressBookingId: number;
    let plusAddressAttendeeId: number;

    d1BeforeAll(async () => {
      const booking = await bookingRepo.createBookingForManagedEventReassignment({
        uid: `attendee-svc-plus-addr-${timestamp}`,
        userId: organizerId,
        userPrimaryEmail: testUser.email,
        eventTypeId: createdEventTypeIds[0],
        title: `Plus Address Test Booking ${timestamp}`,
        description: null,
        startTime: new Date("2030-06-03T10:00:00.000Z"),
        endTime: new Date("2030-06-03T10:30:00.000Z"),
        status: BookingStatus.ACCEPTED,
        location: null,
        smsReminderNumber: null,
        idempotencyKey: `attendee-svc-plus-addr-idempotency-${timestamp}`,
        iCalUID: `attendee-svc-plus-addr-ical-${timestamp}@test.com`,
        iCalSequence: 0,
        attendees: [
          { email: "primary-plus@test.com", name: "Primary", timeZone: "UTC", locale: "en" },
          { email: "guest+abc123@test.com", name: "Plus Guest", timeZone: "UTC", locale: "en" },
        ],
      });
      plusAddressBookingId = booking.id;
      createdBookingIds.push(booking.id);

      await prisma.booking.update({
        where: { id: booking.id },
        data: {
          responses: {
            name: "Primary",
            email: "primary-plus@test.com",
            guests: ["guest+abc123@test.com"],
          },
        },
      });

      const attendees = await prisma.attendee.findMany({
        where: { bookingId: booking.id },
        orderBy: { id: "asc" },
        select: { id: true },
      });
      plusAddressAttendeeId = attendees[1].id;
    });

    it("should remove plus-addressed email from responses.guests using extractBaseEmail", async () => {
      await service.removeAttendee({
        bookingId: plusAddressBookingId,
        attendeeId: plusAddressAttendeeId,
        user: testUser,
        emailsEnabled: false,
      });

      const updatedBooking = await prisma.booking.findUnique({
        where: { id: plusAddressBookingId },
        select: { responses: true },
      });
      const responses = updatedBooking?.responses as { guests?: string[] } | null;
      expect(responses?.guests ?? []).toEqual([]);
    });
  });
});
