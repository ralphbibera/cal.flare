import { hasJobQueue } from "@calcom/features/tasker/queue/context";
import { enqueueJob } from "@calcom/features/tasker/queue/JobQueue";
import type { ITaskerDependencies } from "@calcom/lib/tasker/types";
import type { WebhookTaskPayload } from "../types/webhookTask";
import { deliverWebhookJob } from "./trigger/deliver-webhook";
import type { IWebhookTasker, WebhookDeliveryResult } from "./types";

/**
 * Cloudflare JOBS Webhook Tasker
 *
 * Queues webhook delivery tasks on the JOBS queue for background processing.
 * Used in production environments where ENABLE_ASYNC_TASKER is true and
 * the JOBS binding is available.
 */
export class WebhookTriggerTasker implements IWebhookTasker {
  constructor(public readonly dependencies: ITaskerDependencies) {}

  isConfigured(): boolean {
    return hasJobQueue();
  }

  async deliverWebhook(payload: WebhookTaskPayload): Promise<WebhookDeliveryResult> {
    const { runId } = await enqueueJob(deliverWebhookJob, payload);
    return { taskId: runId };
  }
}
