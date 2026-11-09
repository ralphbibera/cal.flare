import type { JobRetryPolicy } from "@calcom/features/tasker/queue/JobQueue";

export type BookingNotificationTaskConfig = {
  retry: JobRetryPolicy;
};

export const bookingNotificationsTaskConfig: BookingNotificationTaskConfig = {
  retry: {
    maxAttempts: 3,
    factor: 1.8,
    minTimeoutInMs: 500,
    maxTimeoutInMs: 30_000,
    randomize: true,
  },
};
