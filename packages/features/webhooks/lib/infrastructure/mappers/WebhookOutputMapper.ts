import type { TimeUnit } from "@calcom/prisma/enums";
import type { Webhook, WebhookSubscriber } from "../../dto/types";
import { parseWebhookEventTriggers } from "../../eventTriggers";
import { parseWebhookVersion } from "../../interface/IWebhookRepository";

/**
 * Full webhook from Prisma (for CRUD operations)
 */
type PrismaWebhookFull = {
  id: string;
  subscriberUrl: string;
  payloadTemplate: string | null;
  appId: string | null;
  secret: string | null;
  active: boolean;
  eventTriggers: unknown;
  eventTypeId: number | null;
  teamId: number | null;
  userId: number | null;
  time: number | null;
  timeUnit: TimeUnit | null;
  version: string;
  createdAt: Date;
  platform: boolean;
  platformOAuthClientId: string | null;
};

/**
 * Minimal webhook from Prisma (for delivery/subscribers)
 */
type PrismaWebhookMinimal = {
  id: string;
  subscriberUrl: string;
  payloadTemplate: string | null;
  appId: string | null;
  secret: string | null;
  eventTriggers: unknown;
  time: number | null;
  timeUnit: TimeUnit | null;
  version: string;
};

export class WebhookOutputMapper {
  /**
   * Map full Prisma webhook to domain Webhook (for UI/CRUD)
   */
  static toWebhook(prismaWebhook: PrismaWebhookFull): Webhook {
    return {
      id: prismaWebhook.id,
      subscriberUrl: prismaWebhook.subscriberUrl,
      payloadTemplate: prismaWebhook.payloadTemplate,
      appId: prismaWebhook.appId,
      secret: prismaWebhook.secret,
      active: prismaWebhook.active,
      eventTriggers: parseWebhookEventTriggers(prismaWebhook).eventTriggers,
      eventTypeId: prismaWebhook.eventTypeId,
      teamId: prismaWebhook.teamId,
      userId: prismaWebhook.userId,
      time: prismaWebhook.time,
      timeUnit: prismaWebhook.timeUnit,
      version: parseWebhookVersion(prismaWebhook.version),
      createdAt: prismaWebhook.createdAt,
      platform: prismaWebhook.platform,
      platformOAuthClientId: prismaWebhook.platformOAuthClientId,
    };
  }

  static toWebhookList(prismaWebhooks: PrismaWebhookFull[]): Webhook[] {
    return prismaWebhooks.map(WebhookOutputMapper.toWebhook);
  }

  /**
   * Map minimal Prisma webhook to WebhookSubscriber (for delivery)
   */
  static toSubscriber(prismaWebhook: PrismaWebhookMinimal): WebhookSubscriber {
    return {
      id: prismaWebhook.id,
      subscriberUrl: prismaWebhook.subscriberUrl,
      payloadTemplate: prismaWebhook.payloadTemplate,
      appId: prismaWebhook.appId,
      secret: prismaWebhook.secret,
      eventTriggers: parseWebhookEventTriggers(prismaWebhook).eventTriggers,
      time: prismaWebhook.time ?? undefined,
      timeUnit: prismaWebhook.timeUnit ?? undefined,
      version: parseWebhookVersion(prismaWebhook.version),
    };
  }

  static toSubscriberList(prismaWebhooks: PrismaWebhookMinimal[]): WebhookSubscriber[] {
    return prismaWebhooks.map(WebhookOutputMapper.toSubscriber);
  }

  /**
   * Legacy method - kept for backward compatibility
   * @deprecated Use toWebhook() or toSubscriber() based on context
   */
  static toDomain(prismaWebhook: PrismaWebhookMinimal): WebhookSubscriber {
    return WebhookOutputMapper.toSubscriber(prismaWebhook);
  }

  /**
   * Legacy method - kept for backward compatibility
   * @deprecated Use toWebhookList() or toSubscriberList() based on context
   */
  static toDomainList(prismaWebhooks: PrismaWebhookMinimal[]): WebhookSubscriber[] {
    return WebhookOutputMapper.toSubscriberList(prismaWebhooks);
  }

  static toSubscriberPartial(prismaWebhook: {
    id: string;
    subscriberUrl: string;
    eventTriggers: unknown;
    version: string;
    payloadTemplate?: string | null;
    appId?: string | null;
    secret?: string | null;
    time?: number | null;
    timeUnit?: string | null;
  }): WebhookSubscriber {
    return {
      id: prismaWebhook.id,
      subscriberUrl: prismaWebhook.subscriberUrl,
      payloadTemplate: prismaWebhook.payloadTemplate ?? null,
      appId: prismaWebhook.appId ?? null,
      secret: prismaWebhook.secret ?? null,
      eventTriggers: parseWebhookEventTriggers(prismaWebhook).eventTriggers,
      time: prismaWebhook.time ?? undefined,
      timeUnit: prismaWebhook.timeUnit as unknown as WebhookSubscriber["timeUnit"],
      version: parseWebhookVersion(prismaWebhook.version),
    };
  }
}
