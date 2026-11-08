import kysely from "@calcom/kysely";
import { compileD1Statement, requireD1RecordFor } from "@calcom/kysely/d1";
import type { BookingStatus as D1BookingStatus } from "@calcom/kysely/types";
import { getD1Database } from "@calcom/prisma/d1";
import { runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
import type { BookingStatus } from "@calcom/prisma/enums";
import { BookingSchema } from "@calcom/prisma/zod/modelSchema/BookingSchema";
import type { PartialReference } from "@calcom/types/EventManager";
import { z } from "zod";

const paymentRow = z.object({ id: z.number().int(), externalId: z.string() });
const bookingRow = z.object({ status: z.string().toUpperCase().pipe(BookingSchema.shape.status) });

// Prisma enums carry the uppercase client values; D1 stores the lowercase @map values.
const d1BookingStatus = {
  CANCELLED: "cancelled",
  ACCEPTED: "accepted",
  REJECTED: "rejected",
  PENDING: "pending",
  AWAITING_HOST: "awaiting_host",
} satisfies Record<BookingStatus, D1BookingStatus>;

// D1 allows 100 bound parameters per statement, and a reference row binds its ten columns.
const REFERENCES_PER_INSERT = 9;

export type CommitPaymentSuccessInput = {
  paymentId: number;
  bookingId: number;
  status?: BookingStatus;
  referencesToCreate: PartialReference[];
};

// The source array transaction ran the receipt and booking updates as separate D1 queries. One guarded
// batch keeps them atomic, and the nested references stay in the same write as the booking update.
export async function commitPaymentSuccessInD1({
  paymentId,
  bookingId,
  status,
  referencesToCreate,
}: CommitPaymentSuccessInput) {
  const db = getD1Database();
  const bookingStatus = status === undefined ? undefined : d1BookingStatus[status];
  const statements = [
    requireD1RecordFor(
      db,
      { modelName: "Payment", operation: "an update" },
      kysely.selectFrom("Payment").select("id").where("id", "=", paymentId)
    ),
    compileD1Statement(
      db,
      kysely
        .updateTable("Payment")
        .set({ success: 1 })
        .where("id", "=", paymentId)
        .returning(["id", "externalId"])
    ),
    requireD1RecordFor(
      db,
      { modelName: "Booking", operation: "an update" },
      kysely.selectFrom("Booking").select("id").where("id", "=", bookingId)
    ),
    compileD1Statement(
      db,
      kysely
        .updateTable("Booking")
        .set({
          paid: 1,
          ...(bookingStatus === undefined ? {} : { status: bookingStatus }),
          updatedAt: toD1DateTime(new Date()),
        })
        .where("id", "=", bookingId)
        .returning("status")
    ),
  ];

  for (let index = 0; index < referencesToCreate.length; index += REFERENCES_PER_INSERT) {
    const rows = referencesToCreate.slice(index, index + REFERENCES_PER_INSERT).map((reference) => ({
      type: reference.type,
      uid: reference.uid,
      meetingId: reference.meetingId ?? null,
      meetingPassword: reference.meetingPassword ?? null,
      thirdPartyRecurringEventId: reference.thirdPartyRecurringEventId ?? null,
      meetingUrl: reference.meetingUrl ?? null,
      externalCalendarId: reference.externalCalendarId ?? null,
      credentialId: reference.credentialId ?? null,
      delegationCredentialId: reference.delegationCredentialId ?? null,
      bookingId,
    }));
    statements.push(compileD1Statement(db, kysely.insertInto("BookingReference").values(rows)));
  }

  const results = await runD1Batch(db, statements, { modelName: "Booking" });
  return {
    payment: paymentRow.parse(results[1].results[0]),
    booking: bookingRow.parse(results[3].results[0]),
  };
}
