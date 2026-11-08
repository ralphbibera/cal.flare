import { getD1Database } from "@calcom/prisma/d1";
import { requireD1Record, runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
import { BookingStatus } from "@calcom/prisma/enums";
import type { PartialReference } from "@calcom/types/EventManager";
import type { D1PreparedStatement } from "@cloudflare/workers-types";
import { z } from "zod";

const paymentRow = z.object({ id: z.number().int(), externalId: z.string() });
const bookingRow = z.object({
  status: z
    .string()
    .transform((value) => value.toUpperCase())
    .pipe(z.nativeEnum(BookingStatus)),
});

export async function commitPaymentSuccessInD1({
  paymentId,
  bookingId,
  status,
  references,
}: {
  paymentId: number;
  bookingId: number;
  status?: typeof BookingStatus.ACCEPTED;
  references: PartialReference[];
}): Promise<{ payment: z.infer<typeof paymentRow>; booking: z.infer<typeof bookingRow> }> {
  const db = getD1Database();
  const now = toD1DateTime(new Date());
  const bookingStatus = status?.toLowerCase();
  const requireRow = (modelName: "Payment" | "Booking", id: number) =>
    requireD1Record(
      db,
      { modelName, operation: "an update" },
      `SELECT 1 FROM "${modelName}" WHERE "id" = ?`,
      id
    );
  const statements: D1PreparedStatement[] = [
    requireRow("Payment", paymentId),
    db
      .prepare('UPDATE "Payment" SET "success" = 1 WHERE "id" = ? RETURNING "id", "externalId"')
      .bind(paymentId),
    requireRow("Booking", bookingId),
    db
      .prepare(
        `UPDATE "Booking" SET "paid" = 1${bookingStatus ? ', "status" = ?' : ""}, "updatedAt" = ? WHERE "id" = ? RETURNING "status"`
      )
      .bind(...(bookingStatus ? [bookingStatus, now, bookingId] : [now, bookingId])),
  ];
  for (const reference of references) {
    statements.push(
      db
        .prepare(
          `INSERT INTO "BookingReference" ("type", "uid", "meetingId", "thirdPartyRecurringEventId", "meetingPassword", "meetingUrl", "externalCalendarId", "credentialId", "delegationCredentialId", "bookingId")
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .bind(
          reference.type,
          reference.uid,
          reference.meetingId ?? null,
          reference.thirdPartyRecurringEventId ?? null,
          reference.meetingPassword ?? null,
          reference.meetingUrl ?? null,
          reference.externalCalendarId ?? null,
          reference.credentialId ?? null,
          reference.delegationCredentialId ?? null,
          bookingId
        )
    );
  }
  const results = await runD1Batch(db, statements, { modelName: "Booking" });
  return {
    payment: paymentRow.parse(results[1].results[0]),
    booking: bookingRow.parse(results[3].results[0]),
  };
}
