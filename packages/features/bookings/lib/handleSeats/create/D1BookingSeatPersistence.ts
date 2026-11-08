import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { BookingSeat, Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { BookingStatus } from "@calcom/prisma/enums";
import { PrismaClientKnownRequestError } from "@prisma/client/runtime/client";
import { z } from "zod";

export type AddSeatInput = {
  bookingUid: string;
  bookingId: number;
  bookingStatus: BookingStatus;
  seatsPerTimeSlot: number;
  attendee: {
    email: string;
    phoneNumber?: string;
    name: string;
    timeZone: string;
    locale: string;
  };
  seatData: {
    description?: string;
    responses?: Prisma.InputJsonValue | null;
  };
  metadata?: Record<string, string>;
};

const jsonValue: z.ZodType<Prisma.JsonValue> = z.lazy(() =>
  z.union([z.string(), z.number(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)])
);
const storedJson = z
  .string()
  .transform((value) => jsonValue.parse(JSON.parse(value)))
  .nullable();
const seatRow = z.object({
  id: z.number().int(),
  referenceUid: z.string(),
  bookingId: z.number().int(),
  attendeeId: z.number().int(),
  data: storedJson,
  metadata: storedJson,
});
const bookingRows = z.array(
  z.object({ seatCount: z.number().int(), seatBookingExists: z.union([z.literal(0), z.literal(1)]) })
);

export async function addD1BookingSeat(
  input: AddSeatInput,
  referenceUid: string
): Promise<BookingSeat | null> {
  const db = getD1Database();
  const capacity = input.seatsPerTimeSlot > 0 ? input.seatsPerTimeSlot : null;
  const statements = [
    db
      .prepare(`SELECT (SELECT COUNT(*) FROM "Attendee" a WHERE a."bookingId" = b."id"
      AND EXISTS (SELECT 1 FROM "BookingSeat" s WHERE s."attendeeId" = a."id")) AS "seatCount",
      EXISTS (SELECT 1 FROM "Booking" WHERE "id" = ?) AS "seatBookingExists"
      FROM "Booking" b WHERE b."uid" = ?`)
      .bind(input.bookingId, input.bookingUid),
    db
      .prepare(`UPDATE "Booking" SET "status" = CASE WHEN ?1 THEN 'accepted' ELSE "status" END,
        "updatedAt" = CASE WHEN ?1 THEN ?2 ELSE "updatedAt" END
        WHERE "uid" = ?3 AND (?4 IS NULL OR (
          SELECT COUNT(*) FROM "Attendee" a WHERE a."bookingId" = "Booking"."id"
          AND EXISTS (SELECT 1 FROM "BookingSeat" s WHERE s."attendeeId" = a."id")
        ) < ?4) AND EXISTS (SELECT 1 FROM "Booking" WHERE "id" = ?5) RETURNING "id"`)
      .bind(
        input.bookingStatus === BookingStatus.CANCELLED ? 1 : 0,
        new Date().toISOString().replace("Z", "+00:00"),
        input.bookingUid,
        capacity,
        input.bookingId
      ),
    // changes() links admission to this batch, even when a rejected request shares the connection.
    db
      .prepare(`INSERT INTO "Attendee" ("email", "name", "timeZone", "phoneNumber", "locale", "bookingId")
        SELECT ?, ?, ?, ?, ?, "id" FROM "Booking" WHERE "uid" = ? AND changes() = 1`)
      .bind(
        input.attendee.email,
        input.attendee.name,
        input.attendee.timeZone,
        input.attendee.phoneNumber ?? null,
        input.attendee.locale,
        input.bookingUid
      ),
    db
      .prepare(`INSERT INTO "BookingSeat" ("referenceUid", "bookingId", "attendeeId", "data", "metadata")
        SELECT ?, ?, last_insert_rowid(), ?, ? WHERE changes() = 1`)
      .bind(
        referenceUid,
        input.bookingId,
        JSON.stringify({ description: input.seatData.description, responses: input.seatData.responses }),
        input.metadata === undefined ? null : JSON.stringify(input.metadata)
      ),
    db.prepare('SELECT * FROM "BookingSeat" WHERE "referenceUid" = ?').bind(referenceUid),
  ];
  const results = await db.batch(statements).catch((error: unknown) => {
    if (
      error instanceof Error &&
      error.message.includes("UNIQUE constraint failed: BookingSeat.referenceUid")
    ) {
      throw new PrismaClientKnownRequestError("Unique constraint failed on the fields: (`referenceUid`)", {
        code: "P2002",
        clientVersion: "6.16.3",
        meta: { modelName: "Booking", target: ["referenceUid"] },
      });
    }
    if (error instanceof Error && error.message.includes("FOREIGN KEY constraint failed")) {
      throw new PrismaClientKnownRequestError("Foreign key constraint violated", {
        code: "P2003",
        clientVersion: "6.16.3",
        meta: { modelName: "Booking" },
      });
    }
    throw error;
  });
  const booking = bookingRows.parse(results[0].results)[0];
  if (!booking) {
    throw new ErrorWithCode(ErrorCode.BookingNotFound, "Booking not found");
  }
  if (capacity !== null && capacity <= booking.seatCount) {
    throw new ErrorWithCode(ErrorCode.BookingSeatsFull, ErrorCode.BookingSeatsFull);
  }
  if (!booking.seatBookingExists) {
    throw new PrismaClientKnownRequestError(
      "An operation failed because it depends on one or more records that were required but not found. No 'Booking' record (needed to inline the relation on 'BookingSeat' record(s)) was found for a nested connect on one-to-many relation 'BookingToBookingSeat'.",
      {
        code: "P2025",
        clientVersion: "6.16.3",
        meta: {
          modelName: "Booking",
          model: "Booking",
          relation: "BookingToBookingSeat",
          relationType: "one-to-many",
          operation: "a nested connect",
          neededFor: "inline the relation on 'BookingSeat' record(s)",
        },
      }
    );
  }
  return seatRow.nullable().parse(results[4].results[0] ?? null);
}
