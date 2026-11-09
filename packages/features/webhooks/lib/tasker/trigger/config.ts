import type { JobRetryPolicy } from "@calcom/features/tasker/queue/JobQueue";

export type WebhookDeliveryTaskConfig = {
  retry: JobRetryPolicy;
};

export const webhookDeliveryTaskConfig: WebhookDeliveryTaskConfig = {
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 30000,
    maxTimeoutInMs: 600000,
    randomize: true,
  },
};
