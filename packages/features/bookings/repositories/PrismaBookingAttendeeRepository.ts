import type { Prisma, PrismaClient } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { requireD1Record, runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
import type { IBookingAttendeeRepository } from "../lib/dto/IBookingAttendeeRepository";

export class PrismaBookingAttendeeRepository implements IBookingAttendeeRepository {
  constructor(private prismaClient: PrismaClient) {}

  async deleteManyByBookingId(bookingId: number): Promise<void> {
    await this.prismaClient.attendee.deleteMany({
      where: {
        bookingId,
      },
    });
  }

  async deleteByIdAndUpdateBookingResponses(
    attendeeId: number,
    bookingId: number,
    updatedResponses: Prisma.InputJsonValue
  ): Promise<void> {
    const db = getD1Database();
    // Prisma's array transaction is not atomic on D1, so one guarded batch deletes the attendee and rewrites the
    // booking responses. The guards keep delete/update's P2025, which a zero-row write would silently commit.
    await runD1Batch(
      db,
      [
        requireD1Record(
          db,
          { modelName: "Attendee", operation: "a delete" },
          `SELECT 1 FROM "Attendee" WHERE "id" = ?`,
          attendeeId
        ),
        db.prepare(`DELETE FROM "Attendee" WHERE "id" = ?`).bind(attendeeId),
        requireD1Record(
          db,
          { modelName: "Booking", operation: "an update" },
          `SELECT 1 FROM "Booking" WHERE "id" = ?`,
          bookingId
        ),
        db
          .prepare(`UPDATE "Booking" SET "responses" = ?, "updatedAt" = ? WHERE "id" = ?`)
          .bind(JSON.stringify(updatedResponses), toD1DateTime(new Date()), bookingId),
      ],
      { modelName: "Attendee" }
    );
  }
}
