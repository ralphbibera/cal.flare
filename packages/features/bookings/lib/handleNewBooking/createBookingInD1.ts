import { Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { BookingStatus } from "@calcom/prisma/enums";
import { JsonValueSchema } from "@calcom/prisma/zod/inputTypeSchemas/JsonValueSchema";
import { AttendeeSchema } from "@calcom/prisma/zod/modelSchema/AttendeeSchema";
import { BookingReferenceSchema } from "@calcom/prisma/zod/modelSchema/BookingReferenceSchema";
import { BookingSchema } from "@calcom/prisma/zod/modelSchema/BookingSchema";
import { PaymentSchema } from "@calcom/prisma/zod/modelSchema/PaymentSchema";
import { v5 as uuidv5 } from "uuid";
import { z } from "zod";
import type { Tracking } from "./types";

export const bookingRelations = {
  user: {
    select: { uuid: true, email: true, name: true, timeZone: true, username: true, isPlatformManaged: true },
  },
  attendees: true,
  payment: true,
  references: true,
} satisfies Prisma.BookingInclude;

export type BookingPersistenceInput = {
  data: Pick<
    Prisma.BookingCreateInput,
    | "uid"
    | "userPrimaryEmail"
    | "responses"
    | "title"
    | "startTime"
    | "endTime"
    | "description"
    | "customInputs"
    | "oneTimePassword"
    | "location"
    | "smsReminderNumber"
    | "metadata"
    | "dynamicEventSlugRef"
    | "dynamicGroupSlugRef"
    | "iCalUID"
    | "iCalSequence"
    | "creationSource"
    | "recurringEventId"
    | "paid"
    | "fromReschedule"
    | "cancellationReason"
  > & {
    status: typeof BookingStatus.ACCEPTED | typeof BookingStatus.PENDING;
    user: { connect: { id: number } };
    eventType: { connect?: { id: number } };
    destinationCalendar?: { connect: { id: number } };
    attendees: {
      createMany: {
        data: Pick<
          Prisma.AttendeeCreateManyBookingInput,
          "email" | "name" | "timeZone" | "phoneNumber" | "locale"
        >[];
      };
    };
    tracking?: { create: Tracking };
    payment?: { connect: { id: number } };
  };
  cancellation?: {
    where: { id: number };
    data: { rescheduled: true; status: typeof BookingStatus.CANCELLED; rescheduledBy: string | undefined };
  };
};

export type BookingPersistenceResult = Omit<
  Prisma.BookingGetPayload<{ include: typeof bookingRelations }>,
  "scheduledJobs"
> & { scheduledJobs: Prisma.JsonValue | null };

const boolean = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);
const json = z
  .string()
  .transform((value): unknown => JSON.parse(value))
  .pipe(JsonValueSchema);
const bookingRow = BookingSchema.extend({
  status: z.string().toUpperCase().pipe(BookingSchema.shape.status),
  creationSource: z.string().toUpperCase().nullable().pipe(BookingSchema.shape.creationSource),
  userPrimaryEmail: z.string().nullable(),
  cancelledBy: z.string().nullable(),
  rescheduledBy: z.string().nullable(),
  oneTimePassword: z.string().nullable(),
  customInputs: json.nullable(),
  responses: json.nullable(),
  metadata: json.nullable(),
  scheduledJobs: json.nullable(),
  paid: boolean,
  rescheduled: boolean.nullable(),
  isRecorded: boolean,
  noShowHost: boolean.nullable(),
});
const attendeeRow = AttendeeSchema.extend({ noShow: boolean.nullable() });
const paymentRow = PaymentSchema.extend({ success: boolean, refunded: boolean, data: json });
const referenceRow = BookingReferenceSchema.extend({
  deleted: boolean.nullable(),
  type: z.string(),
  uid: z.string(),
});
const userRow = z.object({
  uuid: z.string(),
  email: z.string(),
  name: z.string().nullable(),
  timeZone: z.string(),
  username: z.string().nullable(),
  isPlatformManaged: boolean,
});
const serializeDate = (value: Date | string) => new Date(value).toISOString().replace("Z", "+00:00");
const serializeJson = (value: Prisma.BookingCreateInput["responses"]) =>
  value === undefined || value === Prisma.DbNull
    ? null
    : JSON.stringify(value === Prisma.JsonNull ? null : value);

export async function createBookingInD1({
  data,
  cancellation,
}: BookingPersistenceInput): Promise<BookingPersistenceResult> {
  const db = getD1Database();
  const now = serializeDate(new Date());
  const required = (
    table: "Booking" | "users" | "EventType" | "DestinationCalendar" | "Payment",
    id: number
  ) =>
    db
      .prepare(
        `SELECT CASE WHEN EXISTS (SELECT 1 FROM "${table}" WHERE "id" = ?) THEN 1 ELSE json_extract('{}', 'calflare.booking.${table === "Payment" ? "P2018" : "P2025"}') END`
      )
      .bind(id);
  const statements = [];
  if (cancellation) {
    statements.push(required("Booking", cancellation.where.id));
    statements.push(
      db
        .prepare(
          `UPDATE "Booking" SET "rescheduled" = 1, "status" = 'cancelled', "idempotencyKey" = NULL, "updatedAt" = ?${cancellation.data.rescheduledBy === undefined ? "" : ', "rescheduledBy" = ?'} WHERE "id" = ?`
        )
        .bind(
          now,
          ...(cancellation.data.rescheduledBy === undefined ? [] : [cancellation.data.rescheduledBy]),
          cancellation.where.id
        )
    );
  }
  if (data.destinationCalendar)
    statements.push(required("DestinationCalendar", data.destinationCalendar.connect.id));
  statements.push(required("users", data.user.connect.id));
  if (data.eventType.connect) statements.push(required("EventType", data.eventType.connect.id));
  const idempotencyKey =
    data.status === BookingStatus.ACCEPTED
      ? uuidv5(`${data.startTime.valueOf()}.${data.endTime.valueOf()}.${data.user.connect.id}`, uuidv5.URL)
      : null;
  statements.push(
    db
      .prepare(
        `INSERT INTO "Booking" ("uid", "userPrimaryEmail", "responses", "title", "startTime", "endTime", "description", "customInputs", "status", "oneTimePassword", "location", "smsReminderNumber", "metadata", "dynamicEventSlugRef", "dynamicGroupSlugRef", "iCalUID", "iCalSequence", "userId", "eventTypeId", "destinationCalendarId", "creationSource", "recurringEventId", "paid", "fromReschedule", "cancellationReason", "idempotencyKey", "createdAt", "updatedAt", "scheduledJobs") VALUES (${Array(29).fill("?").join(",")})`
      )
      .bind(
        data.uid,
        data.userPrimaryEmail ?? null,
        serializeJson(data.responses),
        data.title,
        serializeDate(data.startTime),
        serializeDate(data.endTime),
        data.description ?? null,
        serializeJson(data.customInputs),
        data.status.toLowerCase(),
        data.oneTimePassword === undefined ? crypto.randomUUID() : data.oneTimePassword,
        data.location ?? null,
        data.smsReminderNumber ?? null,
        serializeJson(data.metadata),
        data.dynamicEventSlugRef ?? null,
        data.dynamicGroupSlugRef ?? null,
        data.iCalUID === undefined ? "" : data.iCalUID,
        data.iCalSequence ?? 0,
        data.user.connect.id,
        data.eventType.connect?.id ?? null,
        data.destinationCalendar?.connect.id ?? null,
        data.creationSource?.toLowerCase() ?? null,
        data.recurringEventId ?? null,
        data.paid ? 1 : 0,
        data.fromReschedule ?? null,
        data.cancellationReason ?? null,
        idempotencyKey,
        now,
        now,
        "[]"
      )
  );
  statements.push(
    db
      .prepare(
        `INSERT INTO "Attendee" ("email", "name", "timeZone", "phoneNumber", "locale", "bookingId") SELECT json_extract(value, '$.email'), json_extract(value, '$.name'), json_extract(value, '$.timeZone'), json_extract(value, '$.phoneNumber'), json_extract(value, '$.locale'), (SELECT "id" FROM "Booking" WHERE "uid" = ?) FROM json_each(?)`
      )
      .bind(
        data.uid,
        JSON.stringify(
          data.attendees.createMany.data.map((attendee) => ({
            ...attendee,
            locale: attendee.locale === undefined ? "en" : attendee.locale,
          }))
        )
      )
  );
  if (data.tracking) {
    const tracking = data.tracking.create;
    statements.push(
      db
        .prepare(
          `INSERT INTO "Tracking" ("bookingId", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content") VALUES ((SELECT "id" FROM "Booking" WHERE "uid" = ?), ?, ?, ?, ?, ?)`
        )
        .bind(
          data.uid,
          tracking.utm_source ?? null,
          tracking.utm_medium ?? null,
          tracking.utm_campaign ?? null,
          tracking.utm_term ?? null,
          tracking.utm_content ?? null
        )
    );
  }
  if (data.payment) {
    statements.push(
      db
        .prepare(
          `UPDATE "Payment" SET "bookingId" = (SELECT "id" FROM "Booking" WHERE "uid" = ?) WHERE "id" = ?`
        )
        .bind(data.uid, data.payment.connect.id)
    );
    // Source booking constraints fail before a missing payment connect.
    statements.push(required("Payment", data.payment.connect.id));
  }
  const selection = statements.length;
  statements.push(db.prepare('SELECT * FROM "Booking" WHERE "uid" = ?').bind(data.uid));
  for (const table of ["Attendee", "Payment", "BookingReference"])
    statements.push(
      db
        .prepare(
          `SELECT * FROM "${table}" WHERE "bookingId" = (SELECT "id" FROM "Booking" WHERE "uid" = ?) ORDER BY "id"`
        )
        .bind(data.uid)
    );
  statements.push(
    db
      .prepare(
        'SELECT "uuid", "email", "name", "timeZone", "username", "isPlatformManaged" FROM "users" WHERE "id" = ?'
      )
      .bind(data.user.connect.id)
  );
  let results;
  try {
    results = await db.batch(statements);
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    const codes = {
      "calflare.booking.P2025": "P2025",
      "calflare.booking.P2018": "P2018",
      "UNIQUE constraint failed": "P2002",
      "PRIMARY KEY constraint failed": "P2002",
      "NOT NULL constraint failed": "P2011",
      "FOREIGN KEY constraint failed": "P2003",
      "CHECK constraint failed": "P2003",
    };
    const code = Object.entries(codes).find(([message]) => error.message.includes(message))?.[1];
    if (!code) throw error;
    throw new Prisma.PrismaClientKnownRequestError(error.message, {
      code,
      clientVersion: Prisma.prismaVersion.client,
      meta: { modelName: "Booking" },
    });
  }
  return {
    ...bookingRow.parse(results[selection].results[0]),
    attendees: attendeeRow.array().parse(results[selection + 1].results),
    payment: paymentRow.array().parse(results[selection + 2].results),
    references: referenceRow.array().parse(results[selection + 3].results),
    user: userRow.nullable().parse(results[selection + 4].results[0] ?? null),
  };
}
