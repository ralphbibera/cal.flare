import handleCancelBooking from "@calcom/features/bookings/lib/handleCancelBooking";
import { handleMarkAttendeesAndHostNoShow } from "@calcom/features/handleMarkNoShow";
import prisma from "@calcom/prisma";
import type { Booking, EventType, User } from "@calcom/prisma/client";
import { BookingStatus } from "@calcom/prisma/enums";
import { setupMiniflareD1 } from "@calcom/testing/lib/d1/setupMiniflareD1";
import { describe, expect, vi } from "vitest";
import { confirmHandler } from "./confirm.handler";
import { getHandler } from "./get.handler";

const providerFailure = vi.hoisted(() => ({ emails: false }));

vi.mock("@calcom/emails/email-manager", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@calcom/emails/email-manager")>();
  const send = async () => {
    if (providerFailure.emails) throw new Error("email provider unavailable");
  };
  return {
    ...actual,
    sendScheduledEmailsAndSMS: send,
    sendDeclinedEmailsAndSMS: send,
    sendCancelledEmailsAndSMS: send,
  };
});

const d1 = setupMiniflareD1({
  worker: async () => (await import("../../../../../../apps/web/cloudflare.config")).default.worker,
});

const timestamp = Date.now();
const hour = 60 * 60 * 1000;
let owner: User;
let outsider: User;
let eventType: EventType;

const at = (offsetMs: number) => new Date(Date.now() + offsetMs);

const createBooking = (overrides: Partial<Booking> & { uid: string }) =>
  prisma.booking.create({
    data: {
      title: overrides.uid,
      userId: owner.id,
      eventTypeId: eventType.id,
      startTime: at(hour),
      endTime: at(2 * hour),
      status: BookingStatus.ACCEPTED,
      attendees: {
        create: { name: "Guest", email: `${overrides.uid}@example.com`, timeZone: "UTC" },
      },
      ...overrides,
    },
  });

const viewer = () =>
  ({
    id: owner.id,
    email: owner.email,
    profile: { organizationId: null },
  }) as unknown as Parameters<typeof getHandler>[0]["ctx"]["user"];

const list = (filters: Parameters<typeof getHandler>[0]["input"]["filters"], extra = {}) =>
  getHandler({
    ctx: { user: viewer(), prisma },
    input: { filters, limit: 50, offset: 0, ...extra },
  });

d1.beforeAll(async () => {
  owner = await prisma.user.create({
    data: { username: `actions-owner-${timestamp}`, email: `actions-owner-${timestamp}@example.com` },
  });
  outsider = await prisma.user.create({
    data: { username: `actions-outsider-${timestamp}`, email: `actions-outsider-${timestamp}@example.com` },
  });
  eventType = await prisma.eventType.create({
    data: { title: "Actions", slug: `actions-${timestamp}`, length: 30, userId: owner.id },
  });
});

d1.beforeEach(async () => {
  providerFailure.emails = false;
  await prisma.booking.deleteMany({ where: { userId: owner.id } });
  await prisma.credential.deleteMany({ where: { userId: owner.id } });
  await prisma.eventType.update({ where: { id: eventType.id }, data: { metadata: {} } });
});

describe("booking list status partition on D1", () => {
  d1.test("partitions upcoming, unconfirmed, cancelled, past and recurring tabs", async () => {
    const upcoming = await createBooking({ uid: "upcoming", startTime: at(hour), endTime: at(2 * hour) });
    const pending = await createBooking({
      uid: "pending",
      status: BookingStatus.PENDING,
      startTime: at(3 * hour),
      endTime: at(4 * hour),
    });
    const pendingPast = await createBooking({
      uid: "pending-past",
      status: BookingStatus.PENDING,
      startTime: at(-2 * hour),
      endTime: at(-hour),
    });
    const cancelled = await createBooking({
      uid: "cancelled",
      status: BookingStatus.CANCELLED,
      startTime: at(5 * hour),
      endTime: at(6 * hour),
    });
    const rejected = await createBooking({
      uid: "rejected",
      status: BookingStatus.REJECTED,
      startTime: at(7 * hour),
      endTime: at(8 * hour),
    });
    const past = await createBooking({ uid: "past", startTime: at(-3 * hour), endTime: at(-2 * hour) });
    const recurring = await createBooking({
      uid: "recurring",
      recurringEventId: "series",
      startTime: at(9 * hour),
      endTime: at(10 * hour),
    });
    const recurringCancelled = await createBooking({
      uid: "recurring-cancelled",
      recurringEventId: "series",
      status: BookingStatus.CANCELLED,
      startTime: at(11 * hour),
      endTime: at(12 * hour),
    });
    const ids = async (filters: Parameters<typeof getHandler>[0]["input"]["filters"]) =>
      (await list(filters)).bookings.map(({ id }) => id).sort();

    expect(await ids({ status: "upcoming" })).toEqual([upcoming.id, pending.id, recurring.id].sort());
    expect(await ids({ status: "unconfirmed" })).toEqual([pending.id]);
    expect(await ids({ status: "cancelled" })).toEqual(
      [cancelled.id, rejected.id, recurringCancelled.id].sort()
    );
    expect(await ids({ status: "past" })).toEqual([past.id, pendingPast.id].sort());
    expect(await ids({ status: "recurring" })).toEqual([recurring.id]);
    expect(await ids({})).toEqual([upcoming.id, pending.id, recurring.id].sort());
    expect(await ids({ status: "past", statuses: ["cancelled"] })).toEqual(
      [cancelled.id, rejected.id, recurringCancelled.id].sort()
    );
  });

  d1.test("parses the cursor as a nonnegative offset and ignores invalid cursors", async () => {
    const first = await createBooking({ uid: "cursor-1", startTime: at(hour), endTime: at(2 * hour) });
    const second = await createBooking({ uid: "cursor-2", startTime: at(2 * hour), endTime: at(3 * hour) });
    await createBooking({ uid: "cursor-3", startTime: at(3 * hour), endTime: at(4 * hour) });

    const page = await list({ status: "upcoming" }, { limit: 1, cursor: "1" });
    expect(page.bookings.map(({ id }) => id)).toEqual([second.id]);
    expect(page.nextCursor).toBe("2");

    const invalid = await list({ status: "upcoming" }, { limit: 1, cursor: "-1" });
    expect(invalid.bookings.map(({ id }) => id)).toEqual([first.id]);

    const nonNumeric = await list({ status: "upcoming" }, { limit: 1, cursor: "abc" });
    expect(nonNumeric.bookings.map(({ id }) => id)).toEqual([first.id]);
  });

  d1.test("uses the tab default order and the explicit start sort", async () => {
    const later = await createBooking({ uid: "sort-later", startTime: at(4 * hour), endTime: at(5 * hour) });
    const earlier = await createBooking({
      uid: "sort-earlier",
      startTime: at(2 * hour),
      endTime: at(3 * hour),
    });

    const upcoming = await list({ status: "upcoming" });
    expect(upcoming.bookings.map(({ id }) => id)).toEqual([earlier.id, later.id]);

    const cancelled = await createBooking({
      uid: "sort-cancelled",
      status: BookingStatus.CANCELLED,
      startTime: at(6 * hour),
      endTime: at(7 * hour),
    });
    const cancelledTab = await list({ status: "cancelled" });
    expect(cancelledTab.bookings.map(({ id }) => id)).toEqual([cancelled.id]);

    const explicit = await list({ status: "upcoming" }, { sort: { sortStart: "desc" } });
    expect(explicit.bookings.map(({ id }) => id)).toEqual([later.id, earlier.id]);
  });

  d1.test("keeps totalCount and nextCursor aligned with the paginated rows", async () => {
    await createBooking({ uid: "total-1", startTime: at(hour), endTime: at(2 * hour) });
    await createBooking({ uid: "total-2", startTime: at(2 * hour), endTime: at(3 * hour) });
    await createBooking({ uid: "total-3", startTime: at(3 * hour), endTime: at(4 * hour) });

    const page = await list({ status: "upcoming" }, { limit: 2, offset: 0 });
    expect(page.totalCount).toBe(3);
    expect(page.bookings).toHaveLength(2);
    expect(page.nextCursor).toBe("2");

    const last = await list({ status: "upcoming" }, { limit: 2, offset: 2 });
    expect(last.bookings).toHaveLength(1);
    expect(last.nextCursor).toBeUndefined();
  });
});

describe("booking row actions on D1", () => {
  d1.test("confirms a pending booking and rejects an unauthorized or repeated confirmation", async () => {
    const booking = await createBooking({ uid: "confirm", status: BookingStatus.PENDING });

    await expect(
      confirmHandler({
        ctx: { user: { id: outsider.id } } as unknown as Parameters<typeof confirmHandler>[0]["ctx"],
        input: { bookingId: booking.id, confirmed: true, reason: "" },
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      BookingStatus.PENDING
    );

    await expect(
      confirmHandler({
        ctx: { user: { id: owner.id } } as unknown as Parameters<typeof confirmHandler>[0]["ctx"],
        input: { bookingId: booking.id, confirmed: true, reason: "" },
      })
    ).resolves.toEqual({ message: "Booking confirmed", status: BookingStatus.ACCEPTED });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      BookingStatus.ACCEPTED
    );

    await expect(
      confirmHandler({
        ctx: { user: { id: owner.id } } as unknown as Parameters<typeof confirmHandler>[0]["ctx"],
        input: { bookingId: booking.id, confirmed: true, reason: "" },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Booking already confirmed" });
  });

  d1.test("keeps the confirmation when the email provider fails after the write", async () => {
    const booking = await createBooking({ uid: "confirm-email-failure", status: BookingStatus.PENDING });
    providerFailure.emails = true;

    await expect(
      confirmHandler({
        ctx: { user: { id: owner.id } } as unknown as Parameters<typeof confirmHandler>[0]["ctx"],
        input: { bookingId: booking.id, confirmed: true, reason: "" },
      })
    ).resolves.toEqual({ message: "Booking confirmed", status: BookingStatus.ACCEPTED });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      BookingStatus.ACCEPTED
    );
  });

  d1.test("rejects a pending booking with its reason and surfaces a later email failure", async () => {
    const booking = await createBooking({ uid: "reject", status: BookingStatus.PENDING });

    await expect(
      confirmHandler({
        ctx: { user: { id: outsider.id } } as unknown as Parameters<typeof confirmHandler>[0]["ctx"],
        input: { bookingId: booking.id, confirmed: false, reason: "not a fit" },
      })
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });

    await expect(
      confirmHandler({
        ctx: { user: { id: owner.id } } as unknown as Parameters<typeof confirmHandler>[0]["ctx"],
        input: { bookingId: booking.id, confirmed: false, reason: "not a fit", emailsEnabled: true },
      })
    ).resolves.toEqual({ message: "Booking rejected", status: BookingStatus.REJECTED });
    expect(
      await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
        select: { status: true, rejectionReason: true },
      })
    ).toEqual({ status: BookingStatus.REJECTED, rejectionReason: "not a fit" });

    const accepted = await createBooking({ uid: "reject-accepted" });
    await expect(
      confirmHandler({
        ctx: { user: { id: owner.id } } as unknown as Parameters<typeof confirmHandler>[0]["ctx"],
        input: { bookingId: accepted.id, confirmed: false, reason: "again" },
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Booking already confirmed" });

    const late = await createBooking({ uid: "reject-email-failure", status: BookingStatus.PENDING });
    providerFailure.emails = true;
    await expect(
      confirmHandler({
        ctx: { user: { id: owner.id } } as unknown as Parameters<typeof confirmHandler>[0]["ctx"],
        input: { bookingId: late.id, confirmed: false, reason: "late failure", emailsEnabled: true },
      })
    ).rejects.toThrow("email provider unavailable");
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: late.id } })).status).toBe(
      BookingStatus.REJECTED
    );
  });

  d1.test("cancels by uid and keeps the cancelled status when a later step fails", async () => {
    const booking = await createBooking({ uid: "cancel", startTime: at(hour), endTime: at(2 * hour) });

    await expect(
      handleCancelBooking({
        bookingData: { uid: booking.uid },
        userId: owner.id,
      })
    ).rejects.toMatchObject({ statusCode: 400, message: "Cancellation reason is required" });

    const seatedEventType = await prisma.eventType.create({
      data: {
        title: "Seated",
        slug: `seated-${timestamp}`,
        length: 30,
        userId: owner.id,
        seatsPerTimeSlot: 2,
        hosts: { create: { userId: owner.id } },
      },
    });
    const seated = await createBooking({
      uid: "cancel-seated",
      eventTypeId: seatedEventType.id,
      startTime: at(hour),
      endTime: at(2 * hour),
    });
    await expect(
      handleCancelBooking({
        bookingData: { uid: seated.uid, cancellationReason: "conflict" },
        userId: outsider.id,
      })
    ).rejects.toMatchObject({ statusCode: 401, message: "User not a host of this event" });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: seated.id } })).status).toBe(
      BookingStatus.ACCEPTED
    );

    const cancelled = await handleCancelBooking({
      bookingData: { uid: booking.uid, cancellationReason: "conflict" },
      userId: owner.id,
    });
    expect(cancelled).toMatchObject({ success: true, bookingUid: booking.uid });
    expect(
      await prisma.booking.findUniqueOrThrow({
        where: { id: booking.id },
        select: { status: true, cancellationReason: true },
      })
    ).toEqual({ status: BookingStatus.CANCELLED, cancellationReason: "conflict" });

    await expect(
      handleCancelBooking({ bookingData: { uid: booking.uid }, userId: owner.id })
    ).rejects.toMatchObject({ statusCode: 400, message: "This booking has already been cancelled." });

    const late = await createBooking({
      uid: "cancel-email-failure",
      startTime: at(hour),
      endTime: at(2 * hour),
    });
    providerFailure.emails = true;
    await expect(
      handleCancelBooking({
        bookingData: { uid: late.uid, cancellationReason: "conflict" },
        userId: owner.id,
      })
    ).resolves.toMatchObject({ success: true });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: late.id } })).status).toBe(
      BookingStatus.CANCELLED
    );
  });

  d1.test("refuses to cancel an ended booking", async () => {
    const booking = await createBooking({
      uid: "cancel-ended",
      startTime: at(-2 * hour),
      endTime: at(-hour),
    });

    await expect(
      handleCancelBooking({
        bookingData: { uid: booking.uid, cancellationReason: "too late" },
        userId: owner.id,
      })
    ).rejects.toMatchObject({ statusCode: 400, message: "Cannot cancel a booking that has already ended" });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).status).toBe(
      BookingStatus.ACCEPTED
    );
  });

  d1.test("marks and unmarks attendee and host no-show after the meeting started", async () => {
    const booking = await createBooking({
      uid: "no-show",
      startTime: at(-hour),
      endTime: at(hour),
    });
    const attendeeEmail = `${booking.uid}@example.com`;

    await expect(
      handleMarkAttendeesAndHostNoShow({
        bookingUid: booking.uid,
        attendees: [{ email: attendeeEmail, noShow: true }],
        userId: outsider.id,
      })
    ).rejects.toMatchObject({ statusCode: 500, message: "Failed to update no-show status" });
    expect(await prisma.attendee.findFirstOrThrow({ where: { bookingId: booking.id } })).toMatchObject({
      noShow: false,
    });

    await expect(
      handleMarkAttendeesAndHostNoShow({
        bookingUid: booking.uid,
        attendees: [{ email: attendeeEmail, noShow: true }],
        noShowHost: true,
        userId: owner.id,
      })
    ).resolves.toMatchObject({ attendees: [{ email: attendeeEmail, noShow: true }], noShowHost: true });
    expect(await prisma.attendee.findFirstOrThrow({ where: { bookingId: booking.id } })).toMatchObject({
      noShow: true,
    });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).noShowHost).toBe(true);

    await expect(
      handleMarkAttendeesAndHostNoShow({
        bookingUid: booking.uid,
        attendees: [{ email: attendeeEmail, noShow: false }],
        noShowHost: false,
        userId: owner.id,
      })
    ).resolves.toMatchObject({ attendees: [{ email: attendeeEmail, noShow: false }], noShowHost: false });
    expect(await prisma.attendee.findFirstOrThrow({ where: { bookingId: booking.id } })).toMatchObject({
      noShow: false,
    });
  });

  d1.test("refuses no-show before the meeting started and for an unknown booking", async () => {
    const future = await createBooking({
      uid: "no-show-future",
      startTime: at(2 * hour),
      endTime: at(3 * hour),
    });

    await expect(
      handleMarkAttendeesAndHostNoShow({
        bookingUid: future.uid,
        attendees: [{ email: `${future.uid}@example.com`, noShow: true }],
        userId: owner.id,
      })
    ).rejects.toMatchObject({ statusCode: 500, message: "Failed to update no-show status" });
    expect(await prisma.attendee.findFirstOrThrow({ where: { bookingId: future.id } })).toMatchObject({
      noShow: false,
    });

    await expect(
      handleMarkAttendeesAndHostNoShow({
        bookingUid: "missing-booking",
        noShowHost: true,
        userId: owner.id,
      })
    ).rejects.toMatchObject({ statusCode: 500, message: "Failed to update no-show status" });
  });

  d1.test("keeps the attendee no-show write when the CRM app fails afterwards", async () => {
    const booking = await createBooking({
      uid: "no-show-crm",
      startTime: at(-hour),
      endTime: at(hour),
    });
    const credential = await prisma.credential.create({
      data: { type: "salesforce_other_calendar", key: {}, userId: owner.id },
    });
    await prisma.eventType.update({
      where: { id: eventType.id },
      data: {
        metadata: {
          apps: { salesforce: { enabled: true, credentialId: credential.id, appCategories: ["crm"] } },
        },
      },
    });

    await expect(
      handleMarkAttendeesAndHostNoShow({
        bookingUid: booking.uid,
        attendees: [{ email: `${booking.uid}@example.com`, noShow: true }],
        noShowHost: true,
        userId: owner.id,
      })
    ).rejects.toMatchObject({ statusCode: 500, message: "Failed to update no-show status" });
    expect(await prisma.attendee.findFirstOrThrow({ where: { bookingId: booking.id } })).toMatchObject({
      noShow: true,
    });
    expect((await prisma.booking.findUniqueOrThrow({ where: { id: booking.id } })).noShowHost).toBe(false);
  });
});
