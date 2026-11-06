import { WebhookTriggerEvents } from "@calcom/prisma/enums";
import { z } from "zod";

export const webhookEventTriggersSchema = z.array(z.nativeEnum(WebhookTriggerEvents));

export function parseWebhookEventTriggers<T extends { eventTriggers: unknown }>(webhook: T) {
  const { eventTriggers, ...rest } = webhook;
  return {
    ...rest,
    eventTriggers: webhookEventTriggersSchema.parse(eventTriggers === null ? [] : eventTriggers),
  };
}
