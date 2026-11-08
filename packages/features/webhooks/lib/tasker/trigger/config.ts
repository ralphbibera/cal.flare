import type { JobRetryPolicy } from "@calcom/features/tasker/queue/JobQueue";

export type WebhookDeliveryTaskConfig = {
  concurrencyLimit: number;
  retry: JobRetryPolicy;
};

export const webhookDeliveryTaskConfig: WebhookDeliveryTaskConfig = {
  // The shared JOBS consumer runs at the calendars limit of 10 until DO admission applies per-job limits.
  concurrencyLimit: 25,
  retry: {
    maxAttempts: 3,
    factor: 2,
    minTimeoutInMs: 30000,
    maxTimeoutInMs: 600000,
    randomize: true,
  },
};
