import kysely from "@calcom/kysely";
import { compileD1Statement, requireD1RecordFor } from "@calcom/kysely/d1";
import { getD1Database } from "@calcom/prisma/d1";
import { runD1Batch } from "@calcom/prisma/d1-batch";

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
      requireD1RecordFor(
        db,
        { modelName: "Attendee", operation: "an update" },
        kysely.selectFrom("Attendee").select("id").where("id", "=", attendeeId)
      ),
      requireD1RecordFor(
        db,
        { modelName: "BookingSeat", operation: "an update" },
        kysely.selectFrom("BookingSeat").select("id").where("id", "=", bookingSeatId)
      ),
      compileD1Statement(db, kysely.updateTable("Attendee").set({ bookingId }).where("id", "=", attendeeId)),
      compileD1Statement(
        db,
        kysely.updateTable("BookingSeat").set({ bookingId }).where("id", "=", bookingSeatId)
      ),
    ],
    { modelName: "Attendee" }
  );
}
