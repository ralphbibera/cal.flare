import logger from "@calcom/lib/logger";
import { markdownToSafeHTML } from "@calcom/lib/markdownToSafeHTML";
import prisma from "@calcom/prisma";
import type { Prisma } from "@calcom/prisma/client";
import { EventTypeMetaDataSchema } from "@calcom/prisma/zod-utils";
import { z } from "zod";

const log = logger.getSubLogger({ prefix: ["getEventTypesPublic"] });

export type EventTypesPublic = Awaited<ReturnType<typeof getEventTypesPublic>>;

export async function getEventTypesPublic(userId: number) {
  const eventTypesWithHidden = await getEventTypesWithHiddenFromDB(userId);

  const eventTypesRaw = eventTypesWithHidden.filter((evt) => !evt.hidden);

  return eventTypesRaw.map((eventType) => ({
    ...eventType,
    metadata: EventTypeMetaDataSchema.parse(eventType.metadata || {}),
    descriptionAsSafeHTML: markdownToSafeHTML(eventType.description),
  }));
}

const storedBoolean = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);
const storedJson = z
  .string()
  .nullable()
  .transform((value): Prisma.JsonValue => (value === null ? null : JSON.parse(value)));
const publicEventRow = z.object({
  id: z.number().int(),
  title: z.string(),
  description: z.string().nullable(),
  length: z.number().int(),
  schedulingType: z.enum(["roundRobin", "collective", "managed"]).nullable(),
  recurringEvent: storedJson,
  slug: z.string(),
  hidden: storedBoolean,
  price: z.number().int(),
  currency: z.string(),
  lockTimeZoneToggleOnBookingPage: storedBoolean,
  lockedTimeZone: z.string().nullable(),
  requiresConfirmation: storedBoolean,
  requiresBookerEmailVerification: storedBoolean,
  metadata: storedJson,
  canSendCalVideoTranscriptionEmails: storedBoolean,
});

const getEventTypesWithHiddenFromDB = async (userId: number) => {
  const eventTypes = await prisma.$queryRaw<unknown>`
    SELECT data."id", data."title", data."description", data."length", data."schedulingType",
      data."recurringEvent", data."slug", data."hidden", data."price", data."currency",
      data."lockTimeZoneToggleOnBookingPage", data."lockedTimeZone", data."requiresConfirmation", data."requiresBookerEmailVerification",
      data."metadata", data."canSendCalVideoTranscriptionEmails"
      FROM (
        SELECT "EventType"."id", "EventType"."title", "EventType"."description",
          "EventType"."position", "EventType"."length", "EventType"."schedulingType",
          "EventType"."recurringEvent", "EventType"."slug", "EventType"."hidden",
          "EventType"."price", "EventType"."currency",
          "EventType"."lockTimeZoneToggleOnBookingPage", "EventType"."lockedTimeZone", "EventType"."requiresConfirmation",
          "EventType"."requiresBookerEmailVerification", "EventType"."metadata",
          "EventType"."canSendCalVideoTranscriptionEmails", "EventType"."seatsPerTimeSlot"
        FROM "EventType"
        WHERE "EventType"."teamId" IS NULL AND "EventType"."userId" = ${userId}
        UNION
        SELECT "EventType"."id", "EventType"."title", "EventType"."description",
        "EventType"."position", "EventType"."length", "EventType"."schedulingType",
        "EventType"."recurringEvent", "EventType"."slug", "EventType"."hidden",
        "EventType"."price", "EventType"."currency",
        "EventType"."lockTimeZoneToggleOnBookingPage", "EventType"."lockedTimeZone", "EventType"."requiresConfirmation",
        "EventType"."requiresBookerEmailVerification", "EventType"."metadata",
        "EventType"."canSendCalVideoTranscriptionEmails", "EventType"."seatsPerTimeSlot"
        FROM "EventType"
        WHERE "EventType"."teamId" IS NULL
        AND "EventType"."userId" IS NOT NULL
        AND "EventType"."id" IN (
          SELECT "uet1"."A" FROM "_user_eventtype" AS "uet1"
          INNER JOIN "users" AS "u1" ON "u1"."id" = "uet1"."B"
          WHERE "u1"."id" = ${userId} AND "uet1"."A" IS NOT NULL
      )
    ) data
    ORDER BY data."position" DESC, data."id" ASC`;

  // map and filter metadata, exclude eventType entirely when faulty metadata is found.
  // report error to exception so we don't lose the error.
  return publicEventRow
    .array()
    .parse(eventTypes)
    .flatMap((eventType) => {
      const parsedMetadata = EventTypeMetaDataSchema.safeParse(eventType.metadata);
      if (!parsedMetadata.success) {
        log.error(parsedMetadata.error);
        return [];
      }
      return [
        {
          ...eventType,
          metadata: parsedMetadata.data,
        },
      ];
    });
};
