import { getD1Database } from "@calcom/prisma/d1";
import { requireD1Record, runD1Batch } from "@calcom/prisma/d1-batch";
import { uuid } from "short-uuid";

// Prisma's array transaction is not atomic on D1, so one guarded batch moves and deletes the attendees,
// and json_each keeps any number of them within D1's bind limit.
export async function moveSeatedAttendeesInD1({
  bookingId,
  attendeeIdsToMove,
  attendeeIdsToDelete,
}: {
  bookingId: number;
  attendeeIdsToMove: number[];
  attendeeIdsToDelete: number[];
}): Promise<void> {
  const db = getD1Database();
  const moveIds = JSON.stringify(attendeeIdsToMove);
  await runD1Batch(
    db,
    [
      requireD1Record(
        db,
        { modelName: "Attendee", operation: "an update" },
        `SELECT 1 WHERE (SELECT count(*) FROM "Attendee" WHERE "id" IN (SELECT value FROM json_each(?))) = ?`,
        moveIds,
        attendeeIdsToMove.length
      ),
      db
        .prepare(`UPDATE "Attendee" SET "bookingId" = ? WHERE "id" IN (SELECT value FROM json_each(?))`)
        .bind(bookingId, moveIds),
      db
        .prepare(
          `INSERT INTO "BookingSeat" ("referenceUid", "bookingId", "attendeeId")
           SELECT value ->> 'referenceUid', ?, value ->> 'attendeeId' FROM json_each(?) WHERE true
           ON CONFLICT ("attendeeId") DO UPDATE SET "bookingId" = excluded."bookingId"`
        )
        .bind(
          bookingId,
          JSON.stringify(attendeeIdsToMove.map((attendeeId) => ({ attendeeId, referenceUid: uuid() })))
        ),
      db
        .prepare(`DELETE FROM "Attendee" WHERE "id" IN (SELECT value FROM json_each(?))`)
        .bind(JSON.stringify(attendeeIdsToDelete)),
    ],
    { modelName: "Attendee" }
  );
}
