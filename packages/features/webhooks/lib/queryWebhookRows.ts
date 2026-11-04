import type { PrismaClient } from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import { TimeUnit } from "@calcom/prisma/enums";
import { z } from "zod";
import { webhookEventTriggersSchema } from "./eventTriggers";

const storedTriggers = z
  .string()
  .nullable()
  .transform((value) => webhookEventTriggersSchema.parse(value === null ? [] : JSON.parse(value)));
const storedBoolean = z.union([z.literal(0), z.literal(1)]).transform((value) => value === 1);
const storedTimeUnits = { day: TimeUnit.DAY, hour: TimeUnit.HOUR, minute: TimeUnit.MINUTE };
const subscriberRow = z.object({
  id: z.string(),
  subscriberUrl: z.string(),
  payloadTemplate: z.string().nullable(),
  appId: z.string().nullable(),
  secret: z.string().nullable(),
  time: z.number().int().nullable(),
  timeUnit: z
    .enum(["day", "hour", "minute"])
    .transform((value) => storedTimeUnits[value])
    .nullable(),
  eventTriggers: storedTriggers,
  version: z.string(),
});
const ownershipRow = subscriberRow.extend({
  active: storedBoolean,
  teamId: z.number().int().nullable(),
  userId: z.number().int().nullable(),
  platform: storedBoolean,
});
const webhookRow = ownershipRow.extend({
  eventTypeId: z.number().int().nullable(),
  platformOAuthClientId: z.string().nullable(),
  createdAt: z.union([z.date(), z.string(), z.number()]).pipe(z.coerce.date()),
});
const subscriberColumns = Prisma.sql`id, "subscriberUrl", "payloadTemplate", "appId", secret,
  time, "timeUnit", "eventTriggers", version`;
const ownershipColumns = Prisma.sql`${subscriberColumns}, active, "teamId", "userId", platform`;

export function webhookEventsMatch(events: readonly z.infer<typeof webhookEventTriggersSchema>[number][]) {
  const requested = JSON.stringify(webhookEventTriggersSchema.parse(events));
  return Prisma.sql`NOT EXISTS (
    SELECT 1 FROM json_each(${requested}) AS requested
    WHERE NOT EXISTS (
      SELECT 1 FROM json_each("Webhook"."eventTriggers") AS stored
      WHERE stored.value = requested.value
    )
  )`;
}

export async function queryWebhookSubscribers(
  prisma: PrismaClient,
  predicate: Prisma.Sql,
  order = Prisma.empty
) {
  return subscriberRow.array().parse(
    await prisma.$queryRaw<unknown>`
    SELECT ${subscriberColumns} FROM "Webhook" WHERE ${predicate} ${order}
  `
  );
}

export async function queryOrgWebhookSubscribers(prisma: PrismaClient, predicate: Prisma.Sql) {
  return ownershipRow.array().parse(
    await prisma.$queryRaw<unknown>`
    SELECT ${ownershipColumns} FROM "Webhook" WHERE ${predicate}
  `
  );
}

export async function queryWebhookList(prisma: PrismaClient, predicate: Prisma.Sql) {
  return webhookRow.array().parse(
    await prisma.$queryRaw<unknown>`
    SELECT ${ownershipColumns}, "eventTypeId", "platformOAuthClientId", "createdAt"
    FROM "Webhook" WHERE ${predicate}
  `
  );
}
