import { hasJobQueue } from "@calcom/features/tasker/queue/context";
import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import type { WebhookTaskPayload } from "../types/webhookTask";
import { deliverWebhookJob } from "./trigger/deliver-webhook";
import type { IWebhookTasker, WebhookDeliveryResult } from "./types";

/**
 * Cloudflare webhook job tasker
 *
 * Queues webhook delivery tasks on the webhooks queue for background processing.
 * Used in production environments where ENABLE_ASYNC_TASKER is true and
 * the webhooks queue binding is available.
 */
export class WebhookTriggerTasker implements IWebhookTasker {
  constructor(public readonly dependencies: ITaskerDependencies) {}

  isConfigured(): boolean {
    return hasJobQueue("webhooks");
  }

  async deliverWebhook(payload: WebhookTaskPayload): Promise<WebhookDeliveryResult> {
    const { runId } = await deliverWebhookJob.enqueue(payload);
    return { taskId: runId };
  }
}
