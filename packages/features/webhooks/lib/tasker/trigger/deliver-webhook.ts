import { defineQueueJob } from "@calcom/features/tasker/queue/JobQueue";
import { webhookDeliveryTaskConfig } from "./config";
import { webhookDeliveryTaskSchema } from "./schema";

export const WEBHOOK_DELIVERY_JOB_ID = "webhook.deliver";

export const deliverWebhookJob = defineQueueJob({
  id: WEBHOOK_DELIVERY_JOB_ID,
  retry: webhookDeliveryTaskConfig.retry,
  schema: webhookDeliveryTaskSchema,
  run: async (payload, { runId }) => {
    const { getWebhookTaskConsumer } = await import("@calcom/features/di/webhooks/containers/webhook");

    const webhookTaskConsumer = getWebhookTaskConsumer();
    await webhookTaskConsumer.processWebhookTask(payload, runId);
  },
});
