import { ErrorCode } from "@calcom/lib/errorCodes";
import { ErrorWithCode } from "@calcom/lib/errors";
import type { Availability } from "@calcom/prisma/client";
import { Prisma } from "@calcom/prisma/client";
import { getD1Database } from "@calcom/prisma/d1";
import { z } from "zod";

type ScheduleReplacement = {
  scheduleId: number;
  name: string;
  timeZone?: string;
  availability: (Pick<Availability, "startTime" | "endTime"> &
    Partial<Pick<Availability, "days" | "date">>)[];
};

type ReplacedSchedule = Prisma.ScheduleGetPayload<{
  select: {
    id: true;
    userId: true;
    name: true;
    timeZone: true;
    availability: true;
    eventType: { select: { id: true; eventName: true } };
  };
}>;

const scheduleRow = z.object({
  id: z.number().int(),
  userId: z.number().int(),
  name: z.string(),
  timeZone: z.string().nullable(),
});
const availabilityRow = z.object({
  id: z.number().int(),
  userId: z.number().int().nullable(),
  eventTypeId: z.number().int().nullable(),
  scheduleId: z.number().int().nullable(),
  days: z
    .string()
    .nullable()
    .transform((value) => z.array(z.number().int()).parse(value === null ? [] : JSON.parse(value))),
  startTime: z.coerce.date(),
  endTime: z.coerce.date(),
  date: z.coerce.date().nullable(),
});
const eventTypeRow = z.object({ id: z.number().int(), eventName: z.string().nullable() });
const dateText = (date: Date) => date.toISOString().replace(/Z$/, "+00:00");

export class D1ScheduleReplacementRepository {
  static async replace(input: ScheduleReplacement): Promise<ReplacedSchedule> {
    const db = getD1Database();
    const statements = [
      // A missing parent must abort even when there are no child rows to insert.
      db
        .prepare(`INSERT INTO "Schedule" ("id", "userId", "name")
        SELECT ?, NULL, '' WHERE NOT EXISTS (SELECT 1 FROM "Schedule" WHERE "id" = ?)`)
        .bind(input.scheduleId, input.scheduleId),
      db
        .prepare(
          `UPDATE "Schedule" SET "name" = ?${input.timeZone === undefined ? "" : ', "timeZone" = ?'} WHERE "id" = ?`
        )
        .bind(input.name, ...(input.timeZone === undefined ? [] : [input.timeZone]), input.scheduleId),
      db.prepare('DELETE FROM "Availability" WHERE "scheduleId" = ?').bind(input.scheduleId),
      ...input.availability.map((row) =>
        db
          .prepare(
            `INSERT INTO "Availability" ("scheduleId", "days", "startTime", "endTime", "date") VALUES (?, ?, ?, ?, ?)`
          )
          .bind(
            input.scheduleId,
            row.days === undefined ? null : JSON.stringify(row.days),
            dateText(row.startTime),
            dateText(row.endTime),
            row.date ? dateText(row.date) : null
          )
      ),
      db
        .prepare('SELECT "id", "userId", "name", "timeZone" FROM "Schedule" WHERE "id" = ?')
        .bind(input.scheduleId),
      db
        .prepare(
          'SELECT "id", "userId", "eventTypeId", "scheduleId", "days", "startTime", "endTime", "date" FROM "Availability" WHERE "scheduleId" = ? ORDER BY "id"'
        )
        .bind(input.scheduleId),
      db
        .prepare('SELECT "id", "eventName" FROM "EventType" WHERE "scheduleId" = ? ORDER BY "id"')
        .bind(input.scheduleId),
    ];
    let results: Awaited<ReturnType<typeof db.batch>>;
    try {
      results = await db.batch(statements);
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      if (message.includes("NOT NULL constraint failed: Schedule.userId")) {
        throw new Prisma.PrismaClientKnownRequestError(message, {
          code: "P2025",
          clientVersion: Prisma.prismaVersion.client,
          meta: { modelName: "Schedule" },
        });
      }
      const code = /constraint failed|invalid list|expected list array/i.test(message)
        ? ErrorCode.BadRequest
        : ErrorCode.InternalServerError;
      throw Object.assign(new ErrorWithCode(code, "Unable to replace schedule"), { cause });
    }
    const [schedule, availability, eventType] = results.slice(-3);
    return {
      ...scheduleRow.parse(schedule.results[0]),
      availability: z.array(availabilityRow).parse(availability.results),
      eventType: z.array(eventTypeRow).parse(eventType.results),
    };
  }
}
