import { parseWebhookEventTriggers } from "@calcom/platform-libraries";
import type { Webhook } from "@calcom/prisma/client";
import { Injectable, PipeTransform } from "@nestjs/common";

@Injectable()
export class WebhookOutputPipe implements PipeTransform {
  transform(value: Webhook) {
    const { eventTriggers, platformOAuthClientId, ...rest } = parseWebhookEventTriggers(value);
    return { ...rest, triggers: eventTriggers, oAuthClientId: platformOAuthClientId };
  }
}

export type PipedOutputWebhookType = ReturnType<WebhookOutputPipe["transform"]>;
