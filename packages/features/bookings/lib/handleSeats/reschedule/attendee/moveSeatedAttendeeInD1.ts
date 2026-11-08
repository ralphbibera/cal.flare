import { getD1Database } from "@calcom/prisma/d1";
import { requireD1Record, runD1Batch } from "@calcom/prisma/d1-batch";

// Prisma's array transaction is not atomic on D1, so one guarded batch moves the attendee and its seat.
// The guards keep update's P2025 for a missing row, which a zero-row update would silently commit.
export async function moveSeatedAttendeeInD1({
  attendeeId,
  bookingSeatId,
  bookingId,
}: {
  attendeeId: number;
  bookingSeatId: number;
  bookingId: number;
}): Promise<void> {
  const db = getD1Database();
  await runD1Batch(
    db,
    [
      requireD1Record(
        db,
        { modelName: "Attendee", operation: "an update" },
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM "Attendee" WHERE "id" = ?)`,
        attendeeId
      ),
      requireD1Record(
        db,
        { modelName: "BookingSeat", operation: "an update" },
        `SELECT 1 WHERE EXISTS (SELECT 1 FROM "BookingSeat" WHERE "id" = ?)`,
        bookingSeatId
      ),
      db.prepare(`UPDATE "Attendee" SET "bookingId" = ? WHERE "id" = ?`).bind(bookingId, attendeeId),
      db.prepare(`UPDATE "BookingSeat" SET "bookingId" = ? WHERE "id" = ?`).bind(bookingId, bookingSeatId),
    ],
    { modelName: "Attendee" }
  );
}
