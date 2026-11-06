import { withReporting } from "@calcom/lib/sentryWrapper";
import type { PrismaClient } from "@calcom/prisma";
import defaultPrisma from "@calcom/prisma";
import { Prisma } from "@calcom/prisma/client";
import type { WebhookTriggerEvents } from "@calcom/prisma/enums";
import type { WebhookSubscriber } from "./dto/types";
import { WebhookOutputMapper } from "./infrastructure/mappers/WebhookOutputMapper";
import { queryWebhookSubscribers, webhookEventsMatch } from "./queryWebhookRows";

export type GetSubscriberOptions = {
  userId?: number | null;
  eventTypeId?: number | null;
  triggerEvent: WebhookTriggerEvents;
  teamId?: number | number[] | null;
  orgId?: number | null;
  oAuthClientId?: string | null;
};

const getWebhooks = async (
  options: GetSubscriberOptions,
  prisma: PrismaClient = defaultPrisma
): Promise<WebhookSubscriber[]> => {
  const teamId = options.teamId;
  const userId = options.userId ?? 0;
  const eventTypeId = options.eventTypeId ?? 0;
  const teamIds = Array.isArray(teamId) ? teamId : [teamId ?? 0];
  const orgId = options.orgId ?? 0;
  const oAuthClientId = options.oAuthClientId ?? "";

  const managedChildEventType = await prisma.eventType.findFirst({
    where: {
      id: eventTypeId,
      parentId: {
        not: null,
      },
    },
    select: {
      parentId: true,
    },
  });

  const managedParentEventTypeId = managedChildEventType?.parentId ?? 0;

  // if we have userId and teamId it is a managed event type and should trigger for team and user
  const allWebhooks = await queryWebhookSubscribers(
    prisma,
    Prisma.sql`
    active = true AND ${webhookEventsMatch([options.triggerEvent])}
    AND (platform = true OR "userId" = ${userId} OR "eventTypeId" = ${eventTypeId}
      OR "eventTypeId" = ${managedParentEventTypeId}
      OR "teamId" IN (SELECT value FROM json_each(${JSON.stringify([...teamIds, orgId])}))
      OR "platformOAuthClientId" = ${oAuthClientId})
  `
  );

  return allWebhooks.map(WebhookOutputMapper.toSubscriberPartial);
};

export default withReporting(getWebhooks, "getWebhooks");
