import kysely from "@calcom/kysely";
import { compileD1Statement, requireD1RecordFor } from "@calcom/kysely/d1";
import type { Prisma, PrismaClient } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { runD1Batch, toD1DateTime } from "@calcom/prisma/d1-batch";
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
        requireD1RecordFor(
          db,
          { modelName: "Attendee", operation: "a delete" },
          kysely.selectFrom("Attendee").select("id").where("id", "=", attendeeId)
        ),
        compileD1Statement(db, kysely.deleteFrom("Attendee").where("id", "=", attendeeId)),
        requireD1RecordFor(
          db,
          { modelName: "Booking", operation: "an update" },
          kysely.selectFrom("Booking").select("id").where("id", "=", bookingId)
        ),
        compileD1Statement(
          db,
          kysely
            .updateTable("Booking")
            .set({ responses: JSON.stringify(updatedResponses), updatedAt: toD1DateTime(new Date()) })
            .where("id", "=", bookingId)
        ),
      ],
      { modelName: "Attendee" }
    );
  }
}
