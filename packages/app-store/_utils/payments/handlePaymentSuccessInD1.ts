import { getD1Database } from "@calcom/prisma/d1";
import { requireD1Record, runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
import type { BookingStatus } from "@calcom/prisma/enums";
import { BookingSchema } from "@calcom/prisma/zod/modelSchema/BookingSchema";
import type { PartialReference } from "@calcom/types/EventManager";
import { z } from "zod";

const paymentRow = z.object({ id: z.number().int(), externalId: z.string() });
const bookingRow = z.object({ status: z.string().toUpperCase().pipe(BookingSchema.shape.status) });

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
  const statements = [
    requireD1Record(
      db,
      { modelName: "Payment", operation: "an update" },
      'SELECT 1 FROM "Payment" WHERE "id" = ?',
      paymentId
    ),
    db
      .prepare('UPDATE "Payment" SET "success" = 1 WHERE "id" = ? RETURNING "id", "externalId"')
      .bind(paymentId),
    requireD1Record(
      db,
      { modelName: "Booking", operation: "an update" },
      'SELECT 1 FROM "Booking" WHERE "id" = ?',
      bookingId
    ),
    db
      .prepare(
        `UPDATE "Booking" SET "paid" = 1, ${status === undefined ? "" : '"status" = ?, '}"updatedAt" = ? WHERE "id" = ? RETURNING "status"`
      )
      .bind(...(status === undefined ? [] : [status.toLowerCase()]), toD1DateTime(new Date()), bookingId),
  ];

  if (referencesToCreate.length > 0) {
    statements.push(
      db
        .prepare(
          `INSERT INTO "BookingReference" ("type", "uid", "meetingId", "meetingPassword", "thirdPartyRecurringEventId", "meetingUrl", "externalCalendarId", "credentialId", "delegationCredentialId", "bookingId")
          SELECT json_extract(value, '$.type'), json_extract(value, '$.uid'), json_extract(value, '$.meetingId'), json_extract(value, '$.meetingPassword'), json_extract(value, '$.thirdPartyRecurringEventId'), json_extract(value, '$.meetingUrl'), json_extract(value, '$.externalCalendarId'), json_extract(value, '$.credentialId'), json_extract(value, '$.delegationCredentialId'), ?
          FROM json_each(?)`
        )
        .bind(bookingId, JSON.stringify(referencesToCreate))
    );
  }

  const results = await runD1Batch(db, statements, { modelName: "Booking" });
  return {
    payment: paymentRow.parse(results[1].results[0]),
    booking: bookingRow.parse(results[3].results[0]),
  };
}
