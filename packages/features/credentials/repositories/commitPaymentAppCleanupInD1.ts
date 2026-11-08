import type { Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { requireD1Record, runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";

// The source interactive transaction wrote the event type and every unpaid-booking cleanup as one unit.
// One guarded batch keeps those writes together; a later statement failure rolls the whole unit back.
export async function commitPaymentAppCleanupInD1({
  eventTypeId,
  eventTypeMetadata,
  bookingIds,
  paymentIds,
}: {
  eventTypeId: number;
  eventTypeMetadata: Prisma.InputJsonValue;
  bookingIds: number[];
  paymentIds: number[];
}): Promise<void> {
  const db = getD1Database();
  await runD1Batch(
    db,
    [
      requireD1Record(
        db,
        { modelName: "EventType", operation: "an update" },
        'SELECT 1 FROM "EventType" WHERE "id" = ?',
        eventTypeId
      ),
      db
        .prepare('UPDATE "EventType" SET "hidden" = 1, "metadata" = ?, "updatedAt" = ? WHERE "id" = ?')
        .bind(JSON.stringify(eventTypeMetadata), toD1DateTime(new Date()), eventTypeId),
      db
        .prepare(
          `UPDATE "Booking" SET "status" = 'cancelled', "cancellationReason" = ?, "updatedAt" = ?
           WHERE "id" IN (SELECT value FROM json_each(?))`
        )
        .bind("Payment method removed", toD1DateTime(new Date()), JSON.stringify(bookingIds)),
      db
        .prepare('DELETE FROM "Payment" WHERE "id" IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(paymentIds)),
      db
        .prepare('DELETE FROM "Attendee" WHERE "bookingId" IN (SELECT value FROM json_each(?))')
        .bind(JSON.stringify(bookingIds)),
      db
        .prepare(
          'UPDATE "BookingReference" SET "deleted" = 1 WHERE "bookingId" IN (SELECT value FROM json_each(?))'
        )
        .bind(JSON.stringify(bookingIds)),
    ],
    { modelName: "Booking" }
  );
}
