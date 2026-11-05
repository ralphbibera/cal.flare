import type { Prisma } from "@calcom/prisma/client";
import {
  AssignmentReasonEnum,
  BookingReportReason,
  BookingStatus,
  PaymentOption,
  SchedulingType,
} from "@calcom/prisma/enums";
import { z } from "zod";

const text = z.string();
const nullableText = text.nullable();
const integer = z.number().int();
const nullableInteger = integer.nullable();
const boolean = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);
const date = text.datetime({ offset: true }).transform((value) => new Date(value));
const nestedDate = date.transform((value) =>
  value.toISOString().replace(/(?:\.000|(\.\d*?[1-9])0*)Z$/, "$1")
);
const storedJson = text
  .nullable()
  .transform((value): Prisma.JsonValue => (value === null ? null : JSON.parse(value)));
// Only SQL JSON expressions are parsed; ordinary text, including JSON-looking titles, stays text.
const json = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((value) => (typeof value === "string" ? JSON.parse(value) : value), schema);

const row = z.object({
  id: integer,
  title: text,
  userPrimaryEmail: nullableText,
  description: nullableText,
  customInputs: storedJson,
  startTime: date,
  createdAt: date,
  updatedAt: date.nullable(),
  endTime: date,
  metadata: storedJson,
  uid: text,
  responses: storedJson,
  recurringEventId: nullableText,
  location: nullableText,
  status: z.nativeEnum(BookingStatus),
  paid: boolean,
  fromReschedule: nullableText,
  rescheduled: boolean.nullable(),
  rescheduledBy: nullableText,
  cancelledBy: nullableText,
  isRecorded: boolean,
  cancellationReason: nullableText,
  rejectionReason: nullableText,
  eventType: json(
    z
      .object({
        slug: text,
        id: integer,
        title: text,
        eventName: nullableText,
        price: integer,
        recurringEvent: storedJson,
        currency: text,
        metadata: storedJson,
        disableGuests: boolean,
        bookingFields: storedJson,
        seatsPerTimeSlot: nullableInteger,
        seatsShowAttendees: boolean.nullable(),
        seatsShowAvailabilityCount: boolean.nullable(),
        eventTypeColor: storedJson,
        customReplyToEmail: nullableText,
        allowReschedulingPastBookings: boolean,
        hideOrganizerEmail: boolean,
        disableCancelling: boolean.nullable(),
        disableRescheduling: boolean.nullable(),
        minimumRescheduleNotice: nullableInteger,
        teamId: nullableInteger,
        parentId: nullableInteger,
        schedulingType: z.nativeEnum(SchedulingType).nullable(),
        hosts: json(
          z.array(
            z.object({ userId: integer, user: json(z.object({ id: integer, email: text }).nullable()) })
          )
        ),
        length: integer,
        team: json(z.object({ id: integer, name: text, slug: nullableText }).nullable()),
        hostGroups: json(z.array(z.object({ id: text, name: text }))),
      })
      .nullable()
  ),
  references: json(
    z.array(
      z.object({
        id: integer,
        type: text,
        uid: text,
        meetingId: nullableText,
        thirdPartyRecurringEventId: nullableText,
        meetingPassword: nullableText,
        meetingUrl: nullableText,
        bookingId: nullableInteger,
        externalCalendarId: nullableText,
        deleted: boolean.nullable(),
        credentialId: nullableInteger,
        delegationCredentialId: nullableText,
      })
    )
  ),
  payment: json(
    z.array(
      z.object({
        paymentOption: z.nativeEnum(PaymentOption).nullable(),
        amount: integer,
        currency: text,
        success: boolean,
        appId: nullableText,
        refunded: boolean,
      })
    )
  ),
  user: json(
    z
      .object({
        id: integer,
        name: nullableText,
        email: text,
        avatarUrl: nullableText,
        username: nullableText,
        timeZone: text,
      })
      .nullable()
  ),
  attendees: json(
    z.array(
      z.object({
        id: integer,
        email: text,
        name: text,
        timeZone: text,
        phoneNumber: nullableText,
        locale: nullableText,
        bookingId: nullableInteger,
        noShow: boolean.nullable(),
      })
    )
  ),
  seatsReferences: json(
    z.array(z.object({ referenceUid: text, attendee: json(z.object({ email: text }).nullable()) }))
  ),
  assignmentReasonSortedByCreatedAt: json(
    z.array(
      z.object({
        id: integer,
        bookingId: integer,
        createdAt: nestedDate,
        reasonEnum: z.nativeEnum(AssignmentReasonEnum),
        reasonString: text,
      })
    )
  ),
  report: json(
    z
      .object({
        id: text,
        reportedById: nullableInteger,
        reason: z.nativeEnum(BookingReportReason),
        description: nullableText,
        createdAt: nestedDate,
      })
      .nullable()
  ),
});

export const decodeBookingListRow = (value: unknown) => row.parse(value);
